# Final unit fixture follow-through

Frozen full run at `cd93ad1`: 2,155 reported tests, 2,132 passed, 13 skipped, 10 failed. Eight failures are hook failures after root terminated only owned Chrome7412, which had stalled before any renderer/app page. That transient setup failure and its unchanged replay are tracked separately; it is not eight demonstrated product failures.

Commit `5e4cf88` changes only two existing test fixtures:

- `run-log.test.ts` compares every durable snapshot field while explicitly asserting live `approvalPending` is false and absent from journal data. The attention repair deliberately derives this registry projection for API/history views; restoring it from a journal would be wrong. Reload comparisons remain unchanged.
- `transcript-feed-ui.test.ts` gives its stand-in window an actual EventTarget and viewport width. The real feed imports deletion state, which registers a resize listener. The earlier empty object failed before its four tests could run; no product code or feed interleaving assertion changes.

The complete run-log and transcript-feed files plus the final approval-attention regressions pass15/15; TypeScript passes. Logs: `final-unit-followup.log`, `final-unit-followup-tsc.log`. All commands set outer scratch `CODEFLOW_HOME`; no live application or real repositories were used.
