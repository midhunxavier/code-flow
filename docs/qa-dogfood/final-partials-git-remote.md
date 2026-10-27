# Final partial-feature replay: Git and remote workspaces

Execution base: `a4faf8b` (all 55 continuation clusters), branch `codex/qa-final-partials-git-remote`, 2026-10-26. This is the lane E/F report from the final partial-feature plan, not a blanket claim that every platform or real provider has been tested.

All application, build, import and test commands used an explicit outer scratch `CODEFLOW_HOME`. Scratch Git repositories, bare clones/direct refs, isolated homes, fake providers, ephemeral owned ports and owned Chrome profiles only. No push command executed, even to a scratch remote. The push tests below use a command stand-in. Real SSH means an owned loopback OpenSSH daemon with temporary keys and a private known-hosts file on this macOS machine; it does not mean Linux/systemd, a physical remote host or the user's configured SSH hosts.

## Confirmed fixes

1. A real 257 MiB incompressible fetch was safely refused, but the UI said `Code host Git action cancelled; inspect any attempted push before retrying`. The 250 ms storage monitor discarded its exception and aborted the subprocess without a reason. `CodeHostStagingError` now preserves the bounded storage error through cancellation. Read-only cancellation no longer includes push advice; a genuinely interrupted push command retains that advice.
2. An import that completes between monitor ticks could enter the destination object database before the final staging-budget check. The check was after the staging callback. Both local import and push now explicitly check the staging budget and linked cancellation immediately before their effect boundary. The push ledger callback remains after that check and immediately before the push command.

The fast-boundary regression runs real Git against a local bare fixture and grows a sparse staging file immediately after the last staging command. It verifies zero import calls, identical SHA256 hashes for every destination object file, identical refs/status, and quarantine removal. A separate stand-in proves that oversized push staging calls neither `beforeEffect` nor `push`, while the interrupted-push control still calls `beforeEffect` exactly once. A real 257 MiB browser fetch is the independent non-sparse control; local object counts/bytes remain unchanged.

## Per-feature outcomes

| ID | Outcome and exact boundary |
| --- | --- |
| SCH-30 | Passed with fake `gh` and real Chrome/server. A held issue-list subprocess displays Loading from GitHub. Switching the actual composer destination through a new-task deep link while the modal stays open refuses stale dispatch with zero sweep POSTs. Merely changing a project history filter deliberately leaves the draft destination unchanged; the first fixture incorrectly expected that filter to switch the draft. |
| GIT-14 | Passed. A real source tree with 100 files and 5,000 import relationships yields exactly 4,000 edges and `truncated=true`; the review UI displays the scan-limit warning and selected-file relationships. The API response is bounded and completes below the test's 10-second bound. |
| GIT-20 | Passed for the explicit legacy native-source validation boundary. The test-only preload applies legacy lockdown metadata to a completed fake-provider run. Cancel leaves the target and validation receipt unchanged; confirm runs local validation, saved verified state survives reload, a deliberately failing gate is displayed, revalidation succeeds and the reviewed merge completes. This is not a claim that a new imported source bypasses its container/host authorization preflight. |
| GIT-27 | Passed. Actual inverse preview and staging UI, dirty-worktree refusal, moved-HEAD refusal, forged fingerprint409, and fresh reviewed inverse staging. Refusals preserve HEAD/index/status/diff/untracked names; accepted staging deletes the intended file without moving HEAD. The UI must refresh its checkpoint list after an external HEAD change before preparing a new preview. |
| GIT-28 | Passed. Existing final candidate replay confirms a missing checkpoint path requires deletion confirmation. Added replay covers Cancel preserving bytes, confirmed deletion, and positive restoration of an existing file, with HEAD unchanged. |
| GIT-30 | Passed. Older-than-run checkpoint is disabled in UI and refused by API; the run-base checkpoint is enabled and the actual Fork button opens a child at exactly that base commit. |
| GIT-31 | Passed. Final candidate browser replays preserve typed per-repository drafts when switching projects, run two actual fake-provider tasks in dependency order, inspect pinned dependency receipts and prompts, validate the shipping matrix, and explicitly merge both local results. A moved second target is refused before its merge. |
| GIT-33 | Passed. Test-only launch acknowledgement is held after an actual run finishes. UI cancellation followed by releasing the receipt retains the exact result branch and artifacts, records cancellation, and dispatches no dependent attempt. |
| GIT-34 | Passed. Test-only acknowledgement failure makes a registered run temporarily undiscoverable. Once revealed while the server stays live, the visible Matching run field links it explicitly; each node dispatches exactly once and the DAG becomes ready. No restart or silent reassignment. |
| GIT--GAP-01 | Still partial. Read-only planner/reviewer tracked edits are actually made by the fake agent and restored, visible warning is asserted, and the source checkout is byte-for-byte unchanged. Pre-push hook execution remains untested because all pushes were excluded from this lane. |
| GH-27 | Passed with actual Git transport to a local bare fixture and a fake code-host metadata endpoint. The 269,484,032-byte incompressible input is refused visibly at the 256 MiB staging boundary, private quarantine is removed, and destination refs, checkout and object counts/bytes remain unchanged. Real GitHub network/authentication is outside this fixture. |
| SIDE-31 | Still partial. Native Terminal/Editor/Finder windows were not opened; prior launch-shim evidence remains a shim claim. Paired-phone availability/refusal belongs to the isolated listener evidence, not a native launch claim. |
| SIDE-GAP-01 | Still partial. No foreground app capture, desktop screenshot or native computer-control permission action was attempted. Browser-only real model tooling is assigned to the parent's paid-workflow lane. |
| REM-03 | Passed for local SSH transport/UI. The real loopback sshd boots the packaged backend, lists the remote home/project, runs a fake-provider task in a remote worktree, and persists its JSONL under the isolated remote state directory. The existing companion-docs test serves real HTML on `DOCS_PORT=0`, rejects occupied/invalid ports with actionable messages. Remote Linux and physical-network operation remain unclaimed. |
| REM-08 | Passed through real loopback SSH. Side Browser navigates to the local fixture, types `SSH Ada`, clicks Greet and the fixture receives it. Preview WebSocket messages advance from ready to update2. Preview-origin fetch cannot read app API responses; previewing the remote app's own backend port returns400. The browser test waits for the actual fitted viewport frame before input, avoiding deliberately rejected stale frames during initial resize. |
| REM-20 | Still partial. Actual Docker Desktop was not launched; Windows/WSL2 is unavailable here. Packaged macOS SSH evidence does not cover either. |
| PLAT-01 | Passed for supported extension behavior. Final Chrome tests cover invalid/absent/deferred/loaded configuration, pin recovery, and a fixture workflow completing with the built-in fake Claude adapter. ACP and unverified extension provider execution is intentionally disabled and visibly explained in composer/reply/fork, not claimed as working execution. |
| PLAT-13 | Passed. Candidate tests require explicit filtered-task project choice. New real Chrome replay at390px verifies the Workbench controls have no document-level horizontal overflow. |
| PLAT-16 | Passed with a fake Docker transport. A running owned filtered task survives an owned server SIGKILL/restart as unknown, the UI offers explicit stop reconciliation, and confirmed cancellation records `containerStopped=true`; the source HEAD/index/status/diff remain unchanged. This is not actual Docker execution. |
| UX-12 | Passed. Real remote HTML loads through `/computer/<id>/`; only boot `/api/auth/self` is faulted503. The visible Manage connections link returns to the local saved-host UI; removing the fault and opening the connection restores remote UI. |
| PLAT-31 / INFR-GAP-02 | Owned by the independent team/ML lane. No result is asserted here. |

## Evidence and validation

Evidence root: `/private/tmp/codeflow-qa-continue/`.

- New regression source: `test/qa-final-partials-git-remote.test.ts`, `test/e2e/qa-final-partials-git-remote.e2e.ts`, `test/e2e/qa-final-partials-remote-browser.e2e.ts`, `test/qa-final-partials-git-remote-size.test.ts`; the explicit preload is `test/qa-final-partials-git-remote-preload.ts`.
- Five fast budget/cancellation regressions: `final-partials-unit-final.log`.
- Final Git UI evidence: `final-partials-git-browser-final/` and checkpoint positive-control evidence in `final-partials-checkpoint/`; `final-partials-git-browser-final3.log` is 9/9, including the actual checkpoint fork/restore and fresh inverse staging controls.
- Real SSH: `final-partials-real-ssh6.log` (1/1), `final-partials-real-ssh-final/{receipts.json,browser-errors.json,local-server.log,remote-host.log,sshd.log,real-ssh-live-browser.png,real-ssh-boot-recovered.png}`. No page errors; the only console error is the intentional boot503. Initial pointer replay had stale-frame400 refusals; the corrected test synchronizes on viewport/frame dimensions rather than delaying arbitrarily.
- Original incompressible fetch: `final-partials-size.log` proves the old misleading message. Fixed evidence in `final-partials-size-final/` and `final-partials-size-final2.log` (1/1; 9.1-second fetch refusal, 26.7-second total test). One intermediate assertion counted the tsx cache in the private temporary directory as quarantine; the corrected assertion counts only CodeFlow staging directories.
- Final existing candidate suites: `final-partials-candidates-final.log` (15/15), screenshots and observed server/browser logs in `final-partials-candidates-final/`. Includes `qa-filtered-tasks-workbench.e2e.ts`, `qa-coordinated-changes.e2e.ts`, `repo-coordination.e2e.ts`, `qa-acp-extension-providers-ui.test.ts`.
- Companion docs: `final-partials-docs.log` (1/1 targeted existing test).
- TypeScript: `final-partials-tsc-final.log`; `git diff --check` is clean.

Typical commands (all executed from the dedicated worktree):

```sh
CODEFLOW_HOME=/private/tmp/codeflow-qa-continue/final-partials-home node --import tsx --test test/qa-final-partials-git-remote.test.ts
CODEFLOW_HOME=/private/tmp/codeflow-qa-continue/final-partials-home CODEFLOW_QA_EVIDENCE_DIR=/private/tmp/codeflow-qa-continue/final-partials-git-browser-final node --import tsx --test --test-concurrency=1 test/e2e/qa-final-partials-git-remote.e2e.ts
CODEFLOW_HOME=/private/tmp/codeflow-qa-continue/final-partials-home CODEFLOW_TEST_LOOPBACK_SSH=1 CODEFLOW_QA_EVIDENCE_DIR=/private/tmp/codeflow-qa-continue/final-partials-real-ssh-final node --import tsx --test test/e2e/qa-final-partials-remote-browser.e2e.ts
CODEFLOW_HOME=/private/tmp/codeflow-qa-continue/final-partials-size-home CODEFLOW_QA_LARGE_FETCH=1 CODEFLOW_QA_EVIDENCE_DIR=/private/tmp/codeflow-qa-continue/final-partials-size-final node --import tsx --test test/qa-final-partials-git-remote-size.test.ts
CODEFLOW_HOME=/private/tmp/codeflow-qa-continue/final-partials-home node node_modules/typescript/bin/tsc --noEmit
```

Earlier failing logs are retained as fixture debugging history and are not claimed as passing coverage. Native/platform gaps above remain explicitly partial.
