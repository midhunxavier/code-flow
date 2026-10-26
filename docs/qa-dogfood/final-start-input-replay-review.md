# Frozen comparison response timeout diagnosis

Frozen base: `9e4a7f1745bd8b99d5de0d676c887bbd9f3fae1c`. Initial diagnosis used one unchanged whole-file replay from a private, unregistered git-archive checkout at `/private/tmp/codeflow-qa-final-start-input-5wnbkavc`, without editing production or test source or touching integration. The separately authorized fixture correction and modified validation are recorded at the end; there was no second unchanged replay.

## Original evidence preserved

Frozen full browser case 455, “Insights restores comparison draft after reload, sends seven setups after team off, and changes projects without stale text”, failed at `qa-start-input-validation.e2e.ts:113:22` waiting 15,000 ms for a POST `/api/compare` response. The subsequent partial-comparison race, deferred-repository scenario, and console audit passed.

Before replay, all 12 original artifacts were copied to `final-start-input-frozen-evidence/` with SHA256 manifest `final-start-input-frozen-manifest.json`; the bounded raw failure is `final-start-input-frozen-failure.txt`. The original failure text/screenshot show the comparison dialog still saying “Starting…” and four same-task variants already present. The request therefore reached admission; it was not an unclicked button. The original server later reloaded 21 total runs, consistent with the initial 13, all seven comparison runs, and one subsequent deliberately partial comparison. Its browser receipt has zero unexpected errors and the one deliberately aborted offline comparison request.

## Single unchanged replay

Command, from the private checkout:

```sh
CODEFLOW_HOME=/private/tmp/codeflow-qa-continue/final-start-input-replay-home \
HOME=/private/tmp/codeflow-qa-continue/final-start-input-replay-os-home \
ZDOTDIR=/private/tmp/codeflow-qa-continue/final-start-input-replay-os-home \
CODEFLOW_CHROME=/private/tmp/codeflow-qa-continue/work/preview-journeys/qa-chrome \
NODE_OPTIONS='--import /private/tmp/codeflow-qa-continue/final-start-input-observe.mjs' \
DEBUG=pw:api \
node --import tsx --test --test-concurrency=1 --test-timeout=180000 \
  test/e2e/qa-start-input-validation.e2e.ts
```

The external diagnostic observer records request/response events only, without changing requests, waits, assertions or source. Its Playwright instrumentation activates only in the test worker; child processes inherit the module path but fail its filename guard and do not load Playwright or install listeners. It is a diagnostic environment difference, not an assertion or source modification. The fixture's port-block helper reserved 63801–63802 and excludes live ports4317/4318. All server/provider/repository/account state was scratch; providers were fake. The test's own hooks closed its browser/server and removed its transient app home/repositories.

Result: **10 passed, 1 failed, 0 cancelled/skipped**, 130.39 seconds. The same case failed at the same response wait. Test source SHA256 `b36358653207fe133ecede83686273e9724671244d3e8e5f2b5736dfe2771da7` exactly matches frozen git content. Zero unexpected browser errors; the expected offline-abort and restart errors are retained, not suppressed beyond the existing fixture logic. Server log has the normal SQLite experimental warning and fixture restart/shutdown; it reloaded 21 runs.

Evidence: `final-start-input-unchanged-replay.log`, `final-start-input-replay-http.jsonl`, `final-start-input-replay-progress.jsonl`, copied `final-start-input-unchanged-evidence/`, and `final-start-input-unchanged-manifest.json`. All paths are under `/private/tmp/codeflow-qa-continue/`.

## Actual missing-response cause

The replay observed the deliberately aborted offline request separately at 18:29:02.324 (failed nine milliseconds later), then the real seven-variant POST at **18:29:02.390** with the expected task, all seven variants, repeat1, and no taskTeam value. The response waiter expired at **18:29:17.350**. Teardown captured the UI and closed the browser context at **18:29:17.761**.

A read-only authenticated GET of this owned server's run inventory independently captured every variant in group `gmvplbv3q7b52`, with admission timestamps:

| Variant | Created UTC | Since actual POST |
| --- | --- | --- |
| Team | 18:29:12.610 | 10.220s |
| Fix & review | 18:29:13.835 | 11.445s |
| Plan → Build → Review | 18:29:15.310 | 12.920s |
| Loop until green | 18:29:17.018 | 14.628s |
| Best-of-N race | 18:29:18.544 | 16.154s |
| Debate → Synthesize → Build | 18:29:19.900 | 17.510s |
| Supervisor → Workers | 18:29:21.259 | 18.869s |

The route sends201 only after `startComparison` completes: it first awaits admission validation for each variant, then sequentially awaits each `manager.start`, finally returning the full group receipt. The actual last run was not registered until 18.869 seconds after the POST, so the complete response could not exist within this fixture's 15-second wait. The browser was already closed before that point; no complete response for that closed request was captured, and none is claimed. The subsequent two-variant late-race request returned the expected201 partial-group receipt in 5.285 seconds.

This is a **reproduced comparison admission wait-budget mismatch**, supported by actual request, UI and run timestamps, not a “flaky” label inferred from a passing rerun. The exact cost of each validation subprocess was not profiled, and no production performance baseline was measured. The evidence does not show lost admission, duplicate launch, a validation refusal, or a backend deadlock. It also does not prove an acceptable production latency target; it establishes why this particular response wait expired.

## Initial proposed correction

Keep all seven-run response/status/count, no-taskTeam, offline no-new-run, and subsequent project-draft assertions. Give the multi-run admission response an explicit bounded operation budget based on measured admission work, rather than the generic15s locator default; pair it with an explicit case deadline and retain the single-POST/no-retry behavior. For example a60s response budget and90s case deadline would allow measured18.9s admission while still failing a stalled endpoint. This is justified by observed work progressing beyond15s, not a blind timeout increase. The initial report proposed this without applying it; the later authorization and result follow.

## Authorized fixture correction and validation

The parent subsequently authorized the narrow correction on a new dedicated worktree/branch: `/private/tmp/codeflow-qa-final-browser-timing-fixes`, `codex/qa-final-browser-timing-fixes`, from the same frozen9e4a7f1. Commit `bbd4d49a0fb89ab5f1538a2205a2744dc5b18c1a` changes only this comparison test's response wait to60s and adds a90s case bound, with a comment explaining the multi-run admission work. Generic15s UI waits and every existing assertion are retained; no production code changes.

The full modified file passed **11/11**, zero failed/cancelled/skipped, **120.08 seconds**. The diagnostic observer captured the actual seven-run POST201 response after **18,141ms**, with all seven run IDs and no `failed` field. The same test then completed its taskTeam, project-change, draft and reload assertions. The original15s budget would have missed this actual successful response. The deliberately aborted initial comparison still created no runs; the later deliberate repository collision still returned the asserted partial group. TypeScript check passed.

Evidence: `final-start-input-fixed.log`, `final-start-input-fixed-http.jsonl`, `final-start-input-fixed-evidence/` (10 artifacts), `final-start-input-fixed-manifest.json`, and `final-browser-timing-tsc.log`. The modified replay used separate explicit scratch HOME/ZDOTDIR/CODEFLOW_HOME, the approved QA Chrome wrapper, reserved ephemeral ports50272–50273, and the same read-only observer with its output path redirected by QA_START_INPUT_HTTP_LOG. Original frozen failure and the unchanged10/11 result remain preserved separately. This authorized modified validation is not an additional unchanged rerun.
