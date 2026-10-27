# Collaboration browser hook stall follow-up

Source: `cd93ad1` plus test-only follow-ups `c64e510` and `dea09f1`, isolated worktree `/private/tmp/codeflow-qa-final-suite-followup`.

## Frozen full-suite observation

Read-only inspection verified child 99174 was the collaboration permissions UI test in the integration worktree. Its server 1764 was healthy on 127.0.0.1:58560 with setup requests completed; owned Chrome 7412 had GPU/network/storage helpers but no renderer and no application navigation. The fixture had no before/after hook timeout. The precise suspended browser await cannot be recovered from that run; this supports an unbounded browser setup stall, not a proven product defect. The parent independently verified ownership and closed that Chrome to release the frozen run.

## Narrow fixture repair

All eight test bodies and assertions are unchanged. Setup now has a 90-second hook timeout; Chrome launch/connect each have a 30-second limit. Public launchServer/process ownership lets teardown close exactly its browser even if the first context cannot be created. Teardown has a 30-second hook limit, a 10-second force-close fallback for that owned Chrome, and always stops its child servers in a finally block. No production changes, shared helper changes, automatic retries or failure suppression.

## Validation and limitations

- Unmodified independent file replay: 8/8 passed, 34.4 seconds. Receipt: `collab-hang-replay/replay.log` and `outcome.txt`.
- First changed fixture replay: 7/8 passed; case 3 timed out at its existing 60-second limit while browserContext.close was pending during Bob role revocation. Entire run returned in 97.8 seconds. Receipt: `collab-hang-bounded/replay.log` and `outcome.txt`. This failure is retained, not counted as a pass.
- Only allowed retry of changed fixture: 8/8 passed, 41.9 seconds. Receipt: `collab-hang-bounded-retry/replay.log` and `outcome.txt`. One timeout plus one successful retry cannot establish whether the websocket connection changes contributed to the transient context-close stall.
- TypeScript: passed, `collab-hang-bounded-typecheck.log`.
- Deliberately failed setup probe (temporary uncommitted copy, removed afterward): stalled immediately after obtaining owned Chrome 93794 and before connect; shortened hook to 12 seconds. Expected eight hook failures exited 1 in 12.95 seconds, below the independent 45-second outer limit. Chrome 93794 no longer existed; server 92270 logged SIGTERM. Receipt: `collab-hook-timeout-probe/probe.log`, `outcome.txt`, `server.log`. This is cleanup fault injection, not another success retry.

All evidence directories above are under `/private/tmp/codeflow-qa-continue/`. Browser evidence distinguishes page errors from expected conflict/revocation console/transport events. Every test/build/import invocation used an explicit scratch CODEFLOW_HOME; only synthetic scratch accounts/repos and fake providers were used. No live services, account state or user repositories were accessed. Daily SHL20 and rail files were not edited.
