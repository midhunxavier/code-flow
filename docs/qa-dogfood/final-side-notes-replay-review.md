# Final side notes / terminal replay review

Outcome: the frozen full-suite file had **6/7 passing cases**; its final side-chat case failed on an accumulated earlier HTTP 503. Exactly **one unchanged whole-file replay passed 7/7**, exit 0, 84.85 seconds. No production or fixture changes were made or proposed because the authorized unchanged replay did not reproduce the failure.

## Preserved original evidence

Before replay, all six files from integration's `output/playwright/qa-side-notes-terminal/` were copied without following links to `/private/tmp/codeflow-qa-continue/side-notes-unchanged-20261026T182608Z-7d57b938/original-evidence/`. Their byte counts and SHA-256 digests are in `setup.json`, and were checked again after replay. The full-suite log as it existed at capture time is preserved at `/private/tmp/codeflow-qa-continue/side-notes-unchanged-20261026T182608Z-7d57b938/original-full-suite-log-snapshot.log`; the parent log may continue growing independently. The original evidence and shared output were not overwritten by this replay.

Original assertion (full E2E case 433, test file line 225): `pageErrors` contained `503 http://127.0.0.1:59216/api/project-teams?project=p-542f9658`. The final assertion reads arrays accumulated across all seven cases, so its location does not establish that the response happened during the final side-chat case.

The preserved server log establishes the narrower interval:

- Lines 10–16: server PID 87718 is running after the notes-outage restart.
- Line 18: `Stopping code-flow (SIGTERM)`.
- Line 19: `GET /api/project-teams failed: The backend is stopping`.
- Lines 20–26: replacement server PID 89135 starts.

By the unchanged fixture's sequence, this is the **first intentional restart in the interactive-terminal case** (`intentionalNetwork = true; await stop(); await start()`), after the legacy-route case and before the later line-terminal and side-chat cases. The server's `handle()` guard (`src/server.ts:1568` at the frozen commit) returns HTTP 503 once `stopping` is true. Its listener error serializer emits `{"error":"The backend is stopping"}`. The original server log directly establishes the error message and shutdown interval; that JSON body is reconstructed from the exact source path, because the original collector did not retain response bodies or request timestamps. Millisecond timing cannot be recovered from the original artifacts.

The response collector records **every API status >=500** into `pageErrors` regardless of `intentionalNetwork`; the console collector limits expected restart handling to a list of transport error codes. Thus this graceful-shutdown response is recorded as an unexpected application error even within a deliberate outage.

A separate original console entry is `net::ERR_SOCKET_NOT_CONNECTED` on `/api/serve`. That code is absent from the fixture's intentional-network regular expression. The original receipt has no timestamp, so its precise phase and whether the intentional flag was true are unknown. It must not be silently assigned to a restart interval based on inference alone. The original 503 console entry is also preserved. The first final `pageErrors` assertion fails before the subsequent `consoleErrors` assertion runs.

## Unchanged replay method

- Frozen commit: `9e4a7f1745bd8b99d5de0d676c887bbd9f3fae1c`.
- Private **unregistered Git archive copy**: `/private/tmp/codeflow-qa-continue/side-notes-unchanged-20261026T182608Z-7d57b938/source`; no worktree registration was created.
- Source tar SHA-256: `6eb105d048ca7c92c4cd5bb3f289e7b6e3159a7130cbe4c3b5e62c133e1540b0`.
- Test SHA-256 before and after: `b9e73c0803ee653bf1148ee801f6c584c66c77b80e3dde6e99c55dab9ee56b96`.
- Dependencies were a read-only-use symlink to the existing node_modules. No installation occurred.
- Ports 4359/4360 were checked free first; the unchanged shared port-block helper reserved both during fixture setup. Live 4317/4318 were not accessed.
- Outer CODEFLOW_HOME, HOME, ZDOTDIR, TMPDIR and shell all used this replay's scratch paths. The required CODEFLOW_CHROME wrapper was `/private/tmp/codeflow-qa-continue/work/preview-journeys/qa-chrome` (absolute Chrome plus `--use-mock-keychain`). Fake provider CLIs only.
- Invocation: `node --import tsx --test --test-concurrency=1 test/e2e/qa-side-notes-terminal.e2e.ts`, with `QA_SIDE_NOTES_PORT=4359` and `DEBUG=pw:api,pw:browser`; a 210-second outer process-group limit was not reached.
- The fixture hardcodes its evidence directory relative to source rather than accepting an evidence override, so its output landed separately under `/private/tmp/codeflow-qa-continue/side-notes-unchanged-20261026T182608Z-7d57b938/source/output/playwright/qa-side-notes-terminal/`.

## Replay result and limits

All seven original cases passed with all assertions intact. `pageErrors` and `consoleErrors` are empty. The replay recorded 19 expected intentional-network events, compared with 19 in the preserved original. Replay server logs contain the known Node SQLite experimental warning and normal restart/shutdown messages, with no matching project-teams 503 or other application server error.

The native Chrome process emitted a teardown-watchdog message and exited 2 while Playwright was closing it. Playwright's `browser.close()` resolved, the Node test process exited 0, and cleanup finished. This is retained in `replay.log` as a browser-process teardown observation, not described as an application console failure or hidden from the receipt.

A single standalone pass does not erase the original failure or prove the timing race impossible. The standalone concurrency and diagnostic logging can change scheduling. The original shutdown response is explained by direct server evidence, while the separate socket failure's original timing remains uncertain. Per the parent's bounded instruction, no second replay, new fix, or broader investigation was performed.

Artifacts: `setup.json`, `outcome.json`, `replay.log`, `original-evidence/`, the original full-log snapshot, and isolated replay screenshots/browser/server receipts all remain under `/private/tmp/codeflow-qa-continue/side-notes-unchanged-20261026T182608Z-7d57b938/`. `cleanup.json` records no process CWD in the source copy and no listeners on either owned port after completion. Original preserved evidence digests still match. The integration source, frozen tests, real home, real repositories, live servers and current parent full-suite processes were not modified or terminated.

## Recoverable isolated-copy cleanup

After the replay and report, the parent authorized removal of only the unregistered source copy. Its full files, generated output and node_modules symlink (link only; target not followed) were archived and read back against file SHA/mode/link manifests. The unchanged source test hash and empty process-CWD checks were verified before deletion.

- Full archive: `/private/tmp/codeflow-qa-continue/side-notes-unchanged-20261026T182608Z-7d57b938/preserved-source-full.tar.gz`
- SHA-256: `0620f9759e3900288931925f630176c89f5268fff260df82e058d25dd18da744`
- Cleanup receipt: `/private/tmp/codeflow-qa-continue/side-notes-unchanged-20261026T182608Z-7d57b938/source-cleanup-receipt.json`
- Standalone replay screenshots/browser/server receipts now remain at `/private/tmp/codeflow-qa-continue/side-notes-unchanged-20261026T182608Z-7d57b938/replay-evidence`. Former paths under `source/` are also retained under `source/` inside the full archive.

Only the private unregistered copy was removed. Original evidence, replay.log/outcome/setup/cleanup receipts, original source tar, full preservation archive and this report remain central. Registered worktree count did not change; this is separate from the prior101 registered QA-worktree removals. No process was terminated.
