# Independent review of final browser timing fixture corrections

Reviewed source from `/private/tmp/codeflow-qa-final-browser-timing-fixes`, based on frozen `9e4a7f1745bd8b99d5de0d676c887bbd9f3fae1c`. Final commits: comparison `bbd4d49a0fb89ab5f1538a2205a2744dc5b18c1a`; authentication `c1560958bd347d9d0e43127c64c4a3821c16318d`. Read-only review; no tests, browsers, or app calls were launched by this reviewer.

No actionable finding remains. Both changes are limited to existing fixtures; no production source changes. The diff preserves global 15-second Playwright defaults, every existing assertion, and all test declarations (comparison: 72 assertion calls/11 cases; auth: 85 assertion calls/8 cases).

## Comparison admission

The single POST `/api/compare` response wait receives a 60-second operation budget, with a 90-second cap on that case. It does not retry a slow response, reduce the seven-run setup, ignore failures, or alter the offline no-new-runs assertion. The existing exact status201, seven returned IDs, no failed group entry, absent taskTeam, and subsequent project-draft assertions remain.

This is supported by the unchanged replay's actual seven admission timestamps ending18.869 seconds after the POST, beyond the generic15-second response wait. The modified receipt directly captures201 after18.141 seconds with exactly seven IDs and no failed field. Full modified file11/11 passed in120.08 seconds. The original unchanged file10/11 result remains recorded. This proves a fixture wait-budget mismatch, not an acceptable production latency target or a broader performance claim.

Evidence reviewed: `final-start-input-replay-review.md`, `final-start-input-fixed.log`, `final-start-input-fixed-http.jsonl`, and the exact committed diff.

## Cross-port logout navigation

The fixture now waits for A's exact signed-out heading after its unchanged logout200 assertion before `self(p,b)` navigates to B. The heading is rendered by the anonymous boot path after the session transition. SharedDashboard's stream reconnect identity check calls location.reload when the identity is no longer shared; a completed anonymous page therefore supplies a meaningful boundary before cross-port navigation. Existing B-owner and all cookie isolation checks remain.

The frozen failure was B navigation interrupted by an A navigation, before any owner-cookie assertion. The unchanged8/8 pass separately recorded A's unsolicited document navigation just before B's goto. That source-backed chronology supports a synchronization correction; the passing replay does not erase the original failure. The exact original callback stack was not captured and is not claimed.

The modified full file8/8 passed in40.93 seconds; its receipt places the signed-out heading before B navigation, with zero page errors, zero unexpected console errors and six expected responses. Evidence: `final-auth-navigation-review.md`, `auth-navigation-fixed*`, and the exact committed diff.

Final combined typecheck passed (`final-browser-timing-tsc-final.log`); worktree is clean atc156095. No waits/assertions outside these two specific transitions were relaxed.
