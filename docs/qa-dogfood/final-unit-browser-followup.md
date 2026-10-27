# Final unit browser follow-up

The full unit run on `0129dac6cc4d81d39d5c862df0e52b74724b3994` exited with code 1: 2159 tests, 2136 passed, 9 failed, 1 cancelled, 13 skipped, in 1087.229 seconds. All five repaired side-browser cases passed. The exact pin/log hash/counts remain in `final-unit-keychain-validation-pin.json`; the result is not replaced by targeted passes.

## Preserved baseline evidence

`final-unit-browser-failures-preserved/` contains bounded raw failures and SHA256 manifests plus full, non-symlink-following archives of the two owned collaboration/preview scratch fixtures. `QA_ARTIFACT_DIR` was unset in the full unit run, so these fixtures did not save original screenshots, in-memory server logs or browser 400 response bodies. Those missing artifacts cannot be reconstructed and are not claimed.

Each collaboration/preview file received one unchanged full-file replay in `/private/tmp/codeflow-qa-final-unit-browser-replay-qudfdpbf`, exported from 0129. Test source hashes are in `final-unit-browser-replay-source.json`. Replays use explicit scratch CODEFLOW_HOME/HOME/ZDOTDIR and the approved QA Chrome launcher. DEBUG=pw:api plus external `final-unit-browser-observe.mjs` record browser responses and test-worker mutation timings without altering requests, actions, waits or assertions. This is an observational environment difference; the source remains exact. The observer is gated to these two test-worker filenames and does not install in app/provider child processes. Providers and accounts/repositories are scratch/fake; Chrome is real.

## Collaboration context lifecycle

Unchanged file: 7 passed, 0 failed, 1 cancelled after the same 60-second case timeout; 89.365 seconds total. In the demotion case, account mutation returned 200 in 8 ms. `browserContext.close` began at 18:42:54.824 while revocation caused the page to reload at 18:42:54.829. It remained pending until final BrowserServer teardown at 18:44:13.270, 78.446 seconds later. The viewer/reviewer/403 assertions had not yet been reached; this was not an API refusal or failed permission assertion.

Commit `6bdd881` waits for Bob's exact signed-out heading after the successful demotion before closing that context. The existing narrowly scoped revocation transport expectation remains active through the transition; no response/status/authority assertion was removed or relaxed. Full modified file: 8/8 passed in 31.861 seconds. Context close completed in 6 ms after the heading; the viewer/reviewer controls and runner/instruction403 checks all executed. Evidence: `final-collab-unchanged.log`, `final-collab-unchanged-http.jsonl`, `final-collab-unchanged-evidence/`, and corresponding `final-collab-fixed*` paths.

## Snapshot launcher restoration

Two snapshot test sections replaced `CODEFLOW_CHROME` and unconditionally deleted it afterward: the missing-Chrome policy case and the fake dying-executable case. Both discarded the inherited QA launcher before later real captures. Full0129 run reported six native-capture failures plus one cleanup cancellation in this file. The earlier side-browser investigation established this host's raw Chrome Keychain wait with an owned-process stack; no separate snapshot stack was captured because its owned process had already exited. The deterministic environment loss is source-proven; it is not presented as a separately sampled native stack.

Commit `4ab1b92` restores the exact previous environment value in both finally blocks, deleting only when originally absent. All existing assertions stay unchanged. Full modified snapshot file: 9/9 passed in 13.565 seconds, no skips, including refusal policy, desktop/phone sizing, serialized captures, dead/unreachable renderer handling and profile cleanup. `final-snapshot-env-fixed.log` is the receipt. Root authorized no redundant unchanged targeted replay because the full-run raw failures and exact environment leak were already established.

## Preview after-hook diagnostic gap

All 11 cases passed in the original full run, but its after-hook rejected a browser 400 whose navigation URL was not in the deliberately crashed-preview set. The original response body and URL were not persisted. One unchanged replay passed 11/11 in 70.528 seconds, with no browser 400s and zero unexpected console errors; only the deliberately stale scenario 404 was recorded. This does not establish the original cause, erase its failure, or justify an expectation relaxation. Stop/replacement timing is only an unproven possible explanation.

The authorized follow-up is diagnostic only: persist complete responses400/crashUrls before assertions even when QA_ARTIFACT_DIR is unset, using the fixture's unique scratch directory; log its receipt path; include the rejected failure object in the existing strict assertion message. Every expectation remains. Commit `1b763cb` passed the modified full file: **11/11**, 70.294 seconds, with QA_ARTIFACT_DIR explicitly unset. The unique scratch receipt was verified and copied to `final-preview-diagnostics-receipt.json` with its source path/hash manifest. This run also had no browser 400s. The original unexplained failure stays qualified; no product fix is claimed.

Combined typecheck passed (`final-unit-fixtures-complete-tsc.log`). No production files changed and no new full suite was launched; root will integrate all confirmed fixes before final broad validation.

Final branch `codex/qa-final-side-browser-fix` is clean at `1b763cb` in `/private/tmp/codeflow-qa-final-side-browser-fix`. Follow-ups after0129 are separate commits: `4ab1b92`, `6bdd881`, `1b763cb`. This worktree is retained for integration and authorized cleanup.
