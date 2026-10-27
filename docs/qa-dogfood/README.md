# CodeFlow dogfood QA (started 2026-10-25; resumed 2026-10-26)

Current follow-through: the two reproduced product races and scoped phone-audit correction are integrated. Focused checks pass; on frozen `ef60cf0`, full unit/service tests passed 2,158 with 13 skipped and browser tests passed 594 with 17 skipped, with no failures; see [final validation](final-validation.md). The earlier phone 401 remains unclassified.

A developer-style QA pass over the whole CodeFlow app: discover every feature, use each one hands-on (real and fake agents, isolated servers), reproduce every issue independently, then fix → merge → independently verify. The original effort paused partway through the fix phase; the continuation and final validation are complete within the limits in the reports.

## Continuation outcome

- Branch: `codex/dogfood-qa-continue`; worktree: `/Users/mx/.codex/worktrees/dogfood-qa-continue/code-flow`.
- Step 1 branches are integrated: clusters 12, 14, 15 and repairs for 00, 03, 07. Typecheck and 65 targeted tests pass.
- Step 2 is complete: clusters 16–19 and the cluster 05 repair are merged and validated. All clusters 00–19 are now integrated and step 3 independent verification is complete. Additional repairs for paths, draft preservation, approval feedback and required checks passed their targeted integration tests.
- Browser replays use isolated servers built from this branch or dedicated verification worktrees, never the live server. Fresh evidence uses fake agents unless explicitly marked otherwise. Baseline f14f404 passed: unit suite 1,584 passed / 12 skipped; browser suite 221 passed / 12 skipped; zero failures.
- Steps 1–4 are complete: all 55 clusters are integrated through `a4faf8b`. The first full run and subsequent cross-feature repairs are recorded in [final validation](final-validation.md). The final memory repairs and independent follow-through pass. The combined suites completed against fixed source/test revision `cd93ad1`; their raw failures, verified repairs and final policy follow-through are tracked in the validation report. The `9e4a7f1` suites completed with failures and subsequent repairs. On frozen revision `a4509f1`, the unit suite found the preview navigation race; the browser suite found the draft-readiness race and an unclassified phone 401. Both product repairs and the scoped phone-audit correction are integrated; the `ef60cf0` full suites passed with no failures (2,158 unit/service and 594 browser passes). [Final partial-feature coverage](final-partial-coverage.md) records 40 gaps replayed, 12 qualified partial features and one blocked feature.
- Scratch logs and helpers: `/private/tmp/codeflow-qa-continue/`. The historic counts below describe the paused session, not the current completion status.

| | |
|---|---|
| Original integration branch | `claude/dogfood-qa-2026-10-25` (from origin/main `f14f404`, never pushed), worktree `.claude/worktrees/dogfood-qa` |
| Features with a recorded outcome | 508 / 508 (236 works, 52 partial, 219 issue, 1 blocked) |
| Confirmed issues | 559 + 1 lead finding, in 55 clusters |
| Clusters merged | 13 (6 independently verified) |
| Clusters fixed but not merged | 3 + 3 repair branches |
| Clusters interrupted (WIP) | 4 + 1 repair branch |
| Clusters not started | 35 |

- [final-report.md](final-report.md) — per-cluster report, evidence boundaries and cleanup
- [finished.md](finished.md) — what has been done, with results
- [remaining.md](remaining.md) — what is left, in order, plus cleanup
- [coverage.md](coverage.md) — every feature's outcome and evidence
- [clusters/](clusters/) — one file per fix cluster: status, fix/verification results, and for every issue the repro, expected/actual, root cause, files and suggested fix/test
- [tools/](tools/) — the QA server/browser helpers and the fix workflow script
- `data/qa-results.tgz` — raw machine-readable results (issues, suspects, coverage, scenarios, per-cluster inputs); not needed for reading, drop before any PR to main

## Safety rules that applied (keep them when resuming)

- Never restart, kill or drive the live CodeFlow server (ports 4317/4318) or touch ~/.codeflow; never kill processes by name.
- QA servers: own reserved loopback PORT outside4317/4318 (reserve the adjacent listener too), own CODEFLOW_HOME, token `qa-<name>-token`, open at `http://127.0.0.1:<port>/?token=...` (127.0.0.1, not localhost).
- Runs only on scratch clones of the target projects, never the user's real repos; no pushes, no real PRs, no remote changes (fake `gh` via FAKE_GH_STATE).
- Real agent CLIs only for issues that need them, cheapest model/effort, tiny tasks.

## Current outcome

Steps 1–5 and the representative daily/53-row coverage reconciliation are complete within the documented limits. See [remaining work](remaining.md) for manual cleanup and platform boundaries and [final validation](final-validation.md) for the frozen revision and results. Preserve the fresh evidence archives and manifests under `/private/tmp/codeflow-qa-continue/`; the historical discovery archive does not contain these later results.

## Historical continuation recipe

The recipe below was used when the effort had only13 clusters merged. Do not rerun it against the completed continuation or recreate removed branches merely because it refers to them.

1. Read [remaining.md](remaining.md); do steps 1–2 (merge ready branches, finish WIP branches) by hand or with an agent.
2. Copy `tools/qa-server.sh` and `tools/qa-browser.mjs` to a scratch directory and update the `QA=`/`DOGFOOD=` paths at the top of each (they point at the old session scratchpad). Unpack `data/qa-results.tgz` there — the fix workflow reads `fixes-in/<cluster>.json` (the same content as `clusters/*.md`).
3. Run `tools/fix-workflow.js` with the Workflow tool (args template: `tools/fix-args.json`; set `qa` to the new scratch directory, `v1Merged` to the merged `<key>#<round>` ids, and pass only the clusters still to do). It fixes each cluster in its own worktree (`qa-fix/<key>`), merges in batches into the integration branch, verifies independently and runs up to two repair rounds. Fixers reuse an existing worktree/branch, so WIP branches continue where they stopped.
4. Then step 5 of remaining.md.
