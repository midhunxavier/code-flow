# Remaining work

Current follow-through: the two reproduced product races and scoped phone-audit correction are integrated. Focused checks pass; on frozen `ef60cf0`, full unit/service tests passed 2,158 with 13 skipped and browser tests passed 594 with 17 skipped, with no failures; see [final validation](final-validation.md). The earlier phone 401 remains unclassified.

The QA → fix workflow resumed on 2026-10-26 in `codex/dogfood-qa-continue`. Steps 1–4 are complete: all 55 clusters are integrated through `a4faf8b`. Cross-feature follow-ups, the attention-count repair and final boundary replays are integrated. Three bounded real-provider workflows and the 53-row partial/blocked-feature reconciliation are complete. Final memory/inline-code repairs and independent follow-through pass. The full suites and report are complete; the manual cleanup and platform limits below remain.

## Steps 1 and 2 — complete

- Integrated clusters 12, 14, 15 and repairs 00, 03, 07; typecheck and all 65 targeted tests passed after their merges.
- Finished and merged cluster 05's conflict repair, including original-base review provenance, binary/unmerged conflicts, large diffs and legitimate marker overrides. Integrated targeted and browser tests passed.
- Finished and merged 16 chat/thread UI (`405019e`), 17 collaboration attempts (`cd2c7bd`), and 18/19 missions (`dba688d`). The mission integration also passed all 38 combined mission, filesystem-policy and team-control tests.
- Additional independent fixes: policy-closed terminals stay closed after policy removal/reload; isolated Antigravity waits for compatibility discovery and sweeps cannot borrow the composer's native opt-in; approval races retain failure feedback and Claude refusal attribution matches whether an inbox request was offered. See cluster reports for exact evidence and limitations.

## Step 3 — independent verification complete

Completed on isolated QA builds, with cluster reports recording original repros, adjacent cases and limitations. Follow-up merges: `fbc9562` (04/06/08; 30 integrated tests), `91a84e0` (09/10; 11 integrated tests), `42b452b` (11/13; 31 integrated tests). Each passed typecheck. The original verification checklist follows for reference.

For each: start a QA server from a detached worktree of the integration branch, re-run every claimed issue's original repro (UI with headless Chrome where user-visible), try nearby variations, review the cluster diff (`git log --merges --first-parent --grep 'qa-fix/<key>'` gives the merge commit; diff its first parent → merge), and repair what fails.

- [04 run-worktree-lifecycle](clusters/04-run-worktree-lifecycle.md) — Run worktree/branch lifecycle: unpublished/unpersisted worktrees, run-log durability, archive, prefix races (12 issues)
- [06 review-diff-comments](clusters/06-review-diff-comments.md) — Review diffs and comment sending: quoted paths, blank diffs, recipient fallback, provider lock (9 issues)
- [08 composer-permission-menu](clusters/08-composer-permission-menu.md) — Composer permission menu vs what the run gets (trust, tool approvals, Docker, Antigravity defaults) (8 issues)
- [09 composer-draft-config](clusters/09-composer-draft-config.md) — Composer drafts vs repo config: stale check/setup/limits, deleted base, rerun leaks (9 issues)
- [10 composer-presets-global](clusters/10-composer-presets-global.md) — Templates/workflows/project defaults clobber global Agents & models settings (6 issues)
- [11 check-runner-failures](clusters/11-check-runner-failures.md) — Check/gate runner: can't-run gates, Docker daemon down, fixed timeouts, malformed package.json (11 issues)
- [13 schedule-editor-tz](clusters/13-schedule-editor-tz.md) — ScheduleEditor & automation time zones/DST, catch-up, interval validation, stale-tab edits (15 issues)

Also re-verify clusters 00, 03, 07 after their repair branches merge, and cluster 05 after its repair is finished.

Integrator notes to carry into verification: commit `fae5241` made the team task view (`ui/collab-task.tsx`) load lazily to keep startup JS under the 850 KB budget — check that opening a team task still works; `test/e2e/qa-merge-ship-conflicts.e2e.ts` and `test/e2e/qa-run-worktree-lifecycle.e2e.ts` both depend on the merged MergePanel logic in `ui/run.tsx` — run both.

## Step 4 — all 55 clusters integrated

- [20 code-hosts](clusters/20-code-hosts.md) — Code-host fetch/review: untrusted PR branches, 'unknown' receipts, ledger exhaustion, preview errors (6 issues)
- [21 coordinated-changes](clusters/21-coordinated-changes.md) — Coordinated changes: startup crash, revision churn, cancel/retry semantics, raw errors (9 issues)
- [22 side-browser](clusters/22-side-browser.md) — Side-panel live Browser: preview navigation loop, Pick/Box state, stale refs, console, Snapshot remnants (10 issues)
- [23 side-notes-terminal](clusters/23-side-notes-terminal.md) — Side panel notes, terminals and chat: offline draft overwrite, autosave, restart notice, pop-out (9 issues)
- [24 auth-session-accounts](clusters/24-auth-session-accounts.md) — Owner session cookie, sign-in pages and shared accounts (11 issues)
- [25 attention-counts](clusters/25-attention-counts.md) — Inbox/'Needs you' attention counts, notifications at boot, collapsed-rail badge (12 issues)
- [26 history-paging-counts](clusters/26-history-paging-counts.md) — Run history paging: counts from loaded pages, filters, bulk select, breadcrumbs (14 issues)
- [27 projects-ui-store](clusters/27-projects-ui-store.md) — Projects: moving chat runs, Repositories tab, stale edits, unreadable drafts/projects.json (9 issues)
- [28 github-pr-watch](clusters/28-github-pr-watch.md) — PR watch & PR comments: pushing blocked fixes, restart state, merged-outside, duplicate posts (11 issues)
- [29 github-pr-open-picker](clusters/29-github-pr-open-picker.md) — Opening PRs and the GitHub picker: titles from boilerplate, outsider titles in tasks, 50-item cap, GHE (12 issues)
- [30 acp-extension-providers](clusters/30-acp-extension-providers.md) — ACP & extension providers: selectable but never runnable, connection form validation (12 issues)
- [31 diagnostics-maintenance](clusters/31-diagnostics-maintenance.md) — Diagnostics redaction & export, maintenance CLI and retention (9 issues)
- [32 start-input-validation](clusters/32-start-input-validation.md) — Start-input validation & numeric run limits: 500s, silent clamps, compare setups caps (15 issues)
- [33 composer-start-feedback](clusters/33-composer-start-feedback.md) — Composer start blockers, provider/model feedback, files tree, folder picker and Improve (15 issues)
- [34 run-next-action](clusters/34-run-next-action.md) — Run next-action card & status wording: provider/usage stops, failed-no-change results, pause/priority (14 issues)
- [35 automation-records](clusters/35-automation-records.md) — Automation records & routes: deleted projects, no-trigger automations, stale lastError, 500s, unknown kinds (13 issues)
- [36 automation-webhooks](clusters/36-automation-webhooks.md) — Automation webhooks/events: duplicate runs from 'labeled', retry feedback, dry-run fencing (7 issues)
- [37 sweeps-triage](clusters/37-sweeps-triage.md) — Backlog sweeps & triage actions: severity defaults/filter, 25-item cap, triage state guards, warning loss (9 issues)
- [38 collab-task-permissions](clusters/38-collab-task-permissions.md) — Team board tasks: concurrent edit overwrite, role checks, self-review, viewer UI (7 issues)
- [39 collab-connect-link](clusters/39-collab-connect-link.md) — Team connections & runner link: default port, wizard resume, alias duplicates, dead connect check, startup crash (11 issues)
- [40 collab-connection-wording](clusters/40-collab-connection-wording.md) — Team connection selection & stale 'Settings → Team' wording, stream limit, draft loss (9 issues)
- [41 phone-pairing-pages](clusters/41-phone-pairing-pages.md) — Phone pairing & phone-facing pages: ghost devices, raw JSON errors, stale copy, device list (13 issues)
- [42 phone-listener-tls](clusters/42-phone-listener-tls.md) — Phone listener awareness and remote TLS status (9 issues)
- [43 preview-journeys](clusters/43-preview-journeys.md) — Result preview server & recorded scenarios/pins (12 issues)
- [44 run-conversation-bar](clusters/44-run-conversation-bar.md) — Run page conversation bar & message rendering: markdown, notes, drafts, toasts, provider names (10 issues)
- [45 provider-health](clusters/45-provider-health.md) — Provider health dialog & model catalog: usage-limit display, refresh, stale catalogs, probes (8 issues)
- [46 solo-check-docs](clusters/46-solo-check-docs.md) — Solo 'Done when' promises and stale docs pages (patterns, getting-started, help companion) (8 issues)
- [47 shell-dialogs-palette](clusters/47-shell-dialogs-palette.md) — App shell dialogs, toasts and command palette (12 issues)
- [48 a11y-keyboard-layout](clusters/48-a11y-keyboard-layout.md) — Accessibility, keyboard shortcuts and phone layout (11 issues)
- [49 stream-health-tabs](clusters/49-stream-health-tabs.md) — Live stream reconnect, /api/health metrics and cross-tab run deletion (7 issues)
- [50 integration-connections](clusters/50-integration-connections.md) — Integration connections view: disconnect confirmation, workflow leaks, test feedback, truncation (9 issues)
- [51 memory-ml-stats](clusters/51-memory-ml-stats.md) — Project memory analysis, ML training workspace and workflow stats (10 issues)
- [52 team-dialogs-templates](clusters/52-team-dialogs-templates.md) — AI team setup dialogs and team templates (8 issues)
- [53 ssh-clients-packaging](clusters/53-ssh-clients-packaging.md) — SSH connections, desktop/VS Code/CLI clients and packaging scripts (12 issues)
- [54 notifications](clusters/54-notifications.md) — Notification delivery: restart false failures, damaged state, redirects, history, watch keys (5 issues)

## Step 5 — whole-branch validation complete

1. Baseline `f14f404` is complete with zero failures. The first all-cluster run and its repairs are recorded in [final validation](final-validation.md). Final TypeScript, build and 20 memory/asset checks pass; the 850 KB startup threshold is unchanged. The frozen `cd93ad1` suites completed with 10 unit and 12 browser failures; exact raw counts and their fixture/product classification are in the validation report. The final policy UI follow-ups and their independent reviews are integrated; their combined browser replay passes12/12. The `a4509f1` suites found two reproducible product races and an unclassified phone 401; follow-through fixes and unchanged replays are recorded in the validation report. The `ef60cf0` full suites passed with no failures; exact totals and skips are recorded in the validation report.
   Native Chrome preview tests on this macOS host require the QA-only `CODEFLOW_CHROME=/private/tmp/codeflow-qa-continue/work/preview-journeys/qa-chrome` wrapper (`--use-mock-keychain`). Always set the outer scratch `CODEFLOW_HOME` before test imports.
2. Adversarial area reviews are complete, including security/persistence, UI state, final production deltas and late memory/policy follow-through. See the linked reports in [final report](final-report.md); verified findings are integrated.
3. Representative daily workflows and the exact52 originally partial features plus the blocked feature have been replayed/reconciled. [Final partial coverage](final-partial-coverage.md) records40 gaps replayed,12 qualified partials and1 blocked. Three tiny real-provider workflows are complete; the remaining provider/platform boundaries are explicit limits, not an instruction to repeat paid runs.
4. [Coverage](coverage.md) links the final reconciliation, and the [final report](final-report.md) records changes, real versus simulated evidence, unresolved limits and cleanup.
5. Only if the user requests one, open a draft PR of `codex/dogfood-qa-continue` (drop `docs/qa-dogfood/data/` first); never merge to main without review.

## Cleanup still required

- 7 leftover folders `.worktrees/<id>/.context/` in the real MQTT-MCP repo (`/Users/mx/Documents/Work/industriAgents/Connect-MCPs/MQTT-MCP/.worktrees/`: 2610251232-fcac42d6, 2610251801-4eed6085, 2610251807-6763cef1, 2610251814-e3144893, 2610251840-b2a87ada, 2610252029-498e35ea, 2610252238-a3a4e117). They come from QA runs (not in ~/.codeflow/runs) and each holds one small portable-conversation.md; automatic removal was blocked, delete them by hand. (These are historical residuals; context retention while a branch remains is intended, and verified owned worktree/branch cleanup removes context. Their existence alone does not establish a current product defect.)
- Removed 85 historical QA worktrees: 74 clean merged checkouts and 11 with complete verified recovery snapshots. All 26 merged `qa-fix/*` branches were removed. The unmerged `codex/qa-team-dialogs-templates` branch and recovery refs remain. See [historical recovery details](cleanup-historical-worktrees.md); nine additional final lanes and the last seven repair checkouts have also been removed with verified evidence preservation (106 total, including the authentication replay and last four reviewed fix checkouts). [Last repair cleanup](cleanup-last-repair-worktrees.md) and [final fix cleanup](cleanup-final-owned-fixes.md) map their recoverable archives; integration remains. One clean phone replay and three reviewed repair worktrees were later removed with verified preservation, bringing the total to 110; [recent cleanup](cleanup-recent-fixes.md) records their evidence and the 17 retained registered paths.
- Retain the fresh evidence under `/private/tmp/codeflow-qa-continue/`, including screenshots, logs, receipts, verified recovery archives and manifests. `data/qa-results.tgz` contains the historical inventory, not these later results. Remove scratch sets only after their needed evidence has been preserved and verified.
- The OPCUA-MCP `.worktrees/26102508xx-*` entries are the user's own runs from before the QA session — not QA leftovers; leave them.
- No temporary schedules, Docker containers, draft PRs or pushed branches exist from this work.

## Future follow-up

See the [current outcome](README.md#current-outcome) and preserve the safety boundaries if further work is requested.
