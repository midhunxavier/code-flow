# Final branch validation

The validation runs below use an outer scratch `CODEFLOW_HOME`; application fixtures also set their own home, token and loopback ports. An earlier omission and its possible effect are disclosed in [finished work](finished.md#validation-isolation-incident). The live checkout, ports 4317/4318 and real project repositories are excluded. Logs below are in `/private/tmp/codeflow-qa-continue/`.

The table is current. Subsequent sections are chronological evidence; statements that a run or repair is pending describe that earlier checkpoint. The current integrated run is recorded at the end.

## Baseline and first integrated run

| Build | Unit/service | Browser | Evidence |
| --- | --- | --- | --- |
| Baseline `f14f404` | 1,596: 1,584 passed, 12 skipped, 0 failed | 233: 221 passed, 12 skipped, 0 failed | `baseline-unit.log`, `baseline-e2e.log` |
| All 55 clusters, `a4faf8b` | 2,139: 2,109 passed, 12 skipped, 18 failed | 557: 504 passed, 15 skipped, 38 failed | `final-unit.log`, `final-e2e.log` |
| Frozen candidate `cd93ad1` | 2,155: 2,132 passed, 13 skipped, 10 failed | 600: 571 passed, 17 skipped, 12 failed | `final-unit-verified.log`, `final-e2e-verified.log` |
| Frozen `9e4a7f1` | 2,158: 2,140 passed, 13 skipped, 5 failed | 604: 584 passed, 17 skipped, 3 failed | `final-unit-complete.log`, `final-e2e-complete.log` |
| Chrome fixture `0129dac` | 2,159: 2,136 passed, 13 skipped, 9 failed, 1 cancelled | Not rerun at this intermediate pin | `final-unit-keychain-complete.log` |
| Final integrated `a4509f1` | 2,164: 2,150 passed, 13 skipped, 1 failed, 0 cancelled | 606: 587 passed, 17 skipped, 2 failed, 0 cancelled | `final-integrated-unit.log`, `final-integrated-e2e.log` |
| Follow-through `ef60cf0` | 2,171: 2,158 passed, 13 skipped, 0 failed, 0 cancelled | 611: 594 passed, 17 skipped, 0 failed, 0 cancelled | `final-after-races-unit.log`, `final-after-races-e2e.log` |

The first integrated run is not a passing release result. It exposed product regressions and fixture drift described below. Two unit file failures were deliberate termination of owned, idle test processes after identifying Node BroadcastChannels retained by stand-in browser globals; their nine cases pass after correcting those stand-ins. A browser readiness timeout left an owned Chrome process holding test pipes; only that validated QA PID was terminated, and the exact case passed its isolated replay. See `final-unit-hang-cleanup.json`, `final-chrome-cleanup.json` and `final-unit-hang-replay.log`.

The second combined run completed against fixed revision `cd93ad1389d37f9ad0f251d606e9d61ae03ab82e`. Source and tests stayed unchanged for the entire run; only QA documentation changed. `final-validation-pin.json` records tree hashes, runner sessions, final counts and log hashes. TypeScript, build and 20 focused memory/asset checks passed before launch. The candidate still required the follow-ups below; a final combined run will follow their integration.

## Product repair found by the full run

The cluster34 empty-result guard also hid delivery controls for an unchanged linked pull request. `ResultStudio` now keeps a delivery-only card for a linked PR or labelled test run, while omitting empty review, preview and assessment controls. Archived runs still have no result card. The original GitHub Enterprise update replay passes (`final-ghe-fixed.log`), both original delivery workflows pass (`final-original-delivery.log`), and the new `qa-final-result-delivery.e2e.ts` verifies zero changed files, available PR update, test-label precedence and reversible archive (`final-new-delivery.log`).

The final daily workflow reports document the additional model-alias, pending-approval routing, accessible archive count, host action error and Git staging-budget repairs. Those fixes have separate commits and original workflow evidence; they are not treated as fixture changes.

## Why existing test files changed

New product regressions receive new QA test files. The following corrections to existing tests preserve their original assertions while aligning fixtures with other verified cluster changes:

- Review buttons now state the actual comment count; permission controls include their visible `Permissions:` label; stopped runs use `Stopped by you`; project history uses `Without a project`. The checks retain exact counts, permission values and status meaning.
- Accessible step names now come from visible content, with outcome in `aria-description`. Warning and expected-red checks assert that description explicitly. Result headings wait for review coverage before asserting the final label, rather than reading `Inspect saved work` during loading.
- The CI follow-through fixture seeds the previous PR head in a disposable local bare origin. The unpublished-commit guard still blocks workflow tampering, and the assertion verifies the unchanged remote head. Other existing suites can use local bare Git transport; no external repository is published.
- ACP/plugin validation assertions retain the native-delegation refusal. A collaboration checkpoint test waits for the attempt to finish before capturing its revision, so its self-review request tests authorization rather than a stale-revision conflict.
- Browser stand-ins explicitly lack BroadcastChannel, avoiding Node's unrelated process-lifetime behavior. Other browser channel tests remain active.
- Account DELETE is now a supported JSON operation; the server test expects415 without JSON there, while truly unknown paths remain404. Invalidated Team review now has the verified label `Not verified`.
- The integration log audit permits only the two observed read routes and exact `Server is stopping` diagnostic during its explicitly recorded restart interval. It does not ignore arbitrary server errors.
- The preview crash audit matches each browser400 to an actual navigation request, a deliberately crashed fixture's exact URL and `net::ERR_CONNECTION_REFUSED`; other errors still fail. The browser-navigation recovery test injects one explicit navigation failure after healthy HTTP readiness. A process that dies before readiness no longer guarantees a browser request.
- Browser console attachments are verified in persistent IndexedDB and after reload, replacing the old sessionStorage assumption. After a pop-out changes the shared browser viewport, pointer mapping uses the fitted frame; readiness still requires matching tab/view and fresh frames. The console is explicitly reopened after reload before using Clear.
- The no-op labelled-test replay asserts no empty preview/review promise, checks the direct review page's publishing restriction, then archives while retaining files.

Focused evidence: `final-unit-rerun-1.log` (6), `final-unit-rerun-2.log` (3), `final-unit-hang-replay.log` (9), `final-unit-result.log` (10), `final-daily-rerun.log` (12), `final-agy-rerun.log` (6), `final-review-rerun.log` (3), `final-chat-rerun-2.log` (stopped case), `final-result-replays.log` (11 passing before the two step-name corrections), `final-check-labels.log` (2 corrected step cases), `final-history-integrations-rerun.log` (19 passing plus one transient draft timeout), `final-integration-draft-rerun.log` (that draft case passes), `final-preview-fixed.log` (11), and `final-side-browser-fixed2.log` (5). The combined final suites must supersede this collection of focused replays.

All browser runs in this section use real Chrome with fake provider/code-host transports. Real provider and actual SSH evidence is identified separately in the final partial-feature reports.

## Corrections found during the frozen final run

The frozen `cd93ad1` run exposed the following deterministic fixture mismatches, corrected in separate worktrees without changing the running tree:

- `c64e510`: the original Auto Team usage assertion now expects exact singular coordinator/total call labels, retaining the lifetime/limit context. The entire original file passes 5/5 (`final-auto-team-fixed.log`); TypeScript passes.
- `dea09f1`: the original canonical-memory publication fixture now gives its supposed exact copy the same path applicability as the source and asserts equality. Different scopes intentionally remain distinct after the memory repair. Its stale-revision, provenance and deletion assertions stay unchanged; the entire original file passes 4/4 (`final-memory-conflict-fixed.log`); TypeScript passes.

Those two fixtures are integrated. Additional follow-through:

- Eight unit cases failed their shared setup hook after an owned Chrome stalled before creating a renderer. The unchanged replay passes 8/8. `6dc2e3c` adds bounded setup/teardown and explicit ownership; its first replay has a recorded context-close timeout, then its single retry passes 8/8. An injected setup stall exits and cleans up. [Lifecycle evidence](final-browser-lifecycle-fixture.md).
- `5e4cf88` corrects the durable-log comparison for the explicitly ephemeral approval projection and supplies the transcript test’s required viewport event target. All 15 related checks pass. [Unit fixture evidence](final-unit-fixture-followup.md).
- Seven browser cases were interrupted after a reproducible unbounded animation-finished wait. `74f0c5d` replaces it with bounded frame settlement; all eight original cases and the new regression pass without dropping any axe audit. [Animation evidence](final-a11y-animation-wait.md).
- Two policy cases overlapped a real doctor request. `0574e3f` synchronizes fixture requests while retaining the admission refusal and all restriction assertions. Its focused replay additionally found a restricted conventions panel issuing a forbidden private read; that product guard is integrated as `950e81b` with independent held-response review. Its integration replay exposed another fixture activity overlap, corrected by `bcecadc`; its integrated replay and TypeScript pass. Repository-default discovery also needed an actual repository-scoped pause; `65b3cc1` supplies it, followed by `cda10e1` to preserve an unsaved shared-owner draft through the new policy link. The independent review verifies scope, single-use handoff and no implicit storage write.
- `f88b0f0` repairs a genuine waiting-chat race: routing now accepts authoritative pending summaries before inbox payloads arrive. The deterministic baseline fails; the new regression and all 16 original daily cases pass after the fix.

[Independent fixture review](final-fixture-review.md) checks that the corrected assertions and full axe audits remain intact. Owned-process interruption receipts are `final-a11y-hang-cleanup.json` and `final-collab-chrome-hang-cleanup.json`; no unrelated process was stopped. Raw failures remain visible in the table and logs rather than being recounted as original passes.

## Historical frozen validation at `9e4a7f1`

Revision `9e4a7f1745bd8b99d5de0d676c887bbd9f3fae1c` includes all reviewed policy follow-ups. TypeScript and the complete UI/host build pass. Both asset tests pass; the emitted static startup graph is 838,632 bytes against the unchanged 850,000-byte threshold. The four combined policy/collaboration browser files pass 12/12 with no skips.

Both default npm suites started at 2026-10-26 18:00:35 UTC with independent outer scratch homes and the QA Chrome wrapper. Source/test/runtime-input tree hashes and runner IDs are fixed in `final-complete-validation-pin.json`; logs are `final-unit-complete.log` and `final-e2e-complete.log`. No final totals are claimed until both runners finish. Documentation-only updates and recoverable cleanup of inactive scratch checkouts can proceed during the run.

### Allowed unchanged browser replay

The frozen run records a failure in the first `qa-auth-session-accounts.e2e.ts` case: navigation to the second app port was interrupted by the first port’s logout reload. The single permitted unchanged whole-file replay passes8/8. Playwright API timings show the reload and next navigation separated in the replay; the fixture uses a100ms delay rather than a signed-out-page checkpoint. [Auth navigation review](final-auth-navigation-review.md) preserves the raw failure, exact unchanged pin and trace. No cookie/authorization regression was reproduced. This timing flake remains a test reliability limitation; the raw full-suite failure is not recounted as an original pass.

The final unit/service runner completed with exit1:2,140 passed,13 skipped and5 failures in the shared side-browser UI fixture. Chrome stopped advancing its about:blank frame and reported device-metrics/frame-tree protocol timeouts; all five cases using that browser failed. The original evidence is retained, and one unchanged replay is under investigation. Other unit/service cases completed; these five failures are not yet classified as resolved.

### Reproduced side-browser fixture failure

The single unchanged whole-file replay also failed0/5. A sample of its owned Chrome process showed323 samples blocked in macOS keychain authorization (`SecItemAdd` → `defaultKeychainUI` → `AuthorizationCopyRights` → synchronous XPC wait). The fixture had replaced the approved QA Chrome wrapper with a raw executable. `0129dac` changes only that test’s launcher wrappers to retain the inherited configuration and use the mock-keychain flag for the macOS fallback. All five cases pass on the repaired fixture; all24 assertion-bearing lines and five test declarations/timeouts remain unchanged. [Diagnosis](final-side-browser-diagnosis.md) and [independent review](final-side-browser-fixture-review.md) preserve the evidence.

A new complete default unit suite is running in the fix checkout at `0129dac`, with identical production/script/package trees to frozen `9e4a7f1`. Its only non-documentation difference is `test/qa-side-browser-ui.test.ts`, which is not an input to the browser suite. The main checkout remains frozen until the browser run completes; the fixture repair will be integrated afterward. This keeps each runner’s exact executed inputs attributable.

The `9e4a7f1` browser run completed in30m49s with exit1:584 passed,17 skipped and3 failures. Runtime/source/test inputs stayed fixed for both original runners; the pin records completed log hashes. The three browser failures are the logout navigation race, shutdown-audit response and comparison admission wait. The latter also failed its single unchanged replay because all seven starts require roughly19s while the response wait defaults to15s. Narrow fixture corrections are being verified before a final default browser run. No new product source change is supported by these findings.

## Subsequent fixture verification

`bbd4d49` bounds the seven-run comparison response at60s and the case at90s, leaving all other15s page defaults unchanged. The entire modified file passes11/11; its response was201 after18.141s with exactly seven run IDs. `c156095` waits for the actual signed-out heading before the existing cross-port identity assertion; its full file passes8/8. [Independent timing review](final-browser-timing-fixture-review.md) confirms all original assertions remain. The side-notes unchanged replay passes7/7, but an exact restart-window audit correction is being validated rather than broadening error exclusions.

The full `0129dac` unit run completed with2,136 passed,13 skipped,9 failed and1 cancelled (2,159 total). All five repaired side-browser cases passed. Other failures include a permissions UI timeout, a preview navigation-audit hook, the Git snapshot warning, and native screenshot cases after their fixture erased the inherited Chrome override. Exact raw results and hashes are in `final-unit-keychain-validation-pin.json`; these failures are being investigated before final validation.

## Follow-through before the next full run

The permissions UI failure reproduced during BrowserContext.close racing the demotion reload. `6bdd881` waits for the exact signed-out heading before closing; all8 original cases pass and close takes6ms. Both native screenshot environment scopes now restore the inherited Chrome setting (`4ab1b92`); all9 original tests pass. The preview file passes its single unchanged11-case replay, so its original unrecorded400 cause remains unknown; `1b763cb` only preserves complete diagnostics and assertion detail for future failures. It does not widen accepted errors. [Chrome follow-through](final-unit-browser-followup.md) records exact raw and repaired results.

`4edf5a4` replaces the side-notes broad restart flag with observed request lifetimes and actual stop-to-health windows. Only exact shutdown503 bodies on reads or the observed stream-subscription POST, plus explicitly identified offline/transport events, are expected. All7 original cases and the new negative-audit regression pass; [restart audit evidence](final-side-notes-audit-fix.md) retains the initial stricter audit failure and final correction.

The Git warning failure led to a confirmed production defect rather than a fixture relaxation: copied index timestamps can suppress detection of same-size edits. Independent review additionally reproduced loss of original staged state during rollback and invisible staging-only mutations. These related repairs and new QA regressions are in progress; both complete suites must run on their final integrated source.

The Git repairs are now integrated as `cb2692f` and `20b70da`, with five new regressions and19 related tests passing before integration. Independent linked-worktree probes confirm all three baseline failures are repaired, unchanged controls stay unchanged, the real index remains byte/mtime-identical during inspection, and parent checkout changes are preserved. [Fix report](final-snapshot-index-review.md) and [independent review](final-git-index-review.md) define the tested boundaries.

Independent review of the restart audit found that unknown request-failure codes without console output were skipped. `7fff3f9` fixes the audit itself and adds negative checks through the actual classifier. The final8-case file and typecheck pass. An older captured `ERR_ABORTED` has no proven cancellation cause and remains qualified, not retroactively accepted by the corrected audit. [Independent audit review](final-side-notes-audit-review.md) records this boundary.

All confirmed repairs are now integrated. Final preflight passes typecheck, complete build, the strict audit regression, both asset checks and24 Git/snapshot checks. The next default unit and browser suites will use a new fixed integrated pin; earlier raw failures remain in this history.

## Current integrated run

Both default suites started on2026-10-26 at19:03UTC against fixed revision `a4509f143f99206576b113418c81e98e66eea9f5`, after all confirmed runtime and fixture repairs. `final-integrated-validation-pin.json` records all source/test/runtime-input tree hashes, preflight results, build receipts and runner sessions. Only documentation and inactive-checkout cleanup can change while these runners execute.

The integrated unit run completed with exit 1: 2,150 passed, 13 skipped, one failed and none cancelled. The failure is the preview-journeys after-hook audit: one browser navigation to a URL outside the recorded deliberate-crash set was refused. The complete response and URL were preserved in the fixture diagnostic receipt. An unchanged whole-file replay reproduced the causal timing: navigation to a healthy preview began 253 ms after its Stop request returned 200, then failed because the server had stopped. A product fix for obsolete automatic navigation is under review; the raw failure remains a failure. `final-integrated-validation-pin.json` records the completed unit log hash and result. The browser suite finished against the same unchanged inputs with exit 1: 587 passed, 17 skipped, two failed and none cancelled.

The completed integrated browser suite reported two failures: external-issue handoff refused while project drafts were loading, and the phone-pairing after-hook recorded a project-counts 401. The external-issue whole-file unchanged replay reproduced its refusal (11/12 passing); a readiness fix is in progress. The phone-pairing whole-file unchanged replay passed 6/6, but the original 401 lacks enough timing evidence to classify; it remains a raw failure.

The draft handoff repair (`8d1a99f`) is now integrated. Its new held-initialization regression and the unchanged original file pass 18/18 on the combined branch, and typecheck passes (`integrate-draft-readiness-browser.log`, `integrate-draft-readiness-tsc.log`). [Its report](final-integration-draft-readiness.md) preserves the failing baseline and single unchanged replay. An independent review found no remaining issue in its documented scope (`final-integration-draft-readiness-review.md` under the scratch evidence root). A controlled phone revocation reproduced a legitimate 401 after a held counts request was released following successful device removal; that demonstrates one possible cause but does not establish the timing or cause of the original 401.

## Follow-through integrated validation

Revision `ef60cf046eb921ff319ae82c3586db7946937f45` integrates the independently reviewed draft-readiness repair, phone audit correction, and preview navigation repair. On the combined branch, typecheck passes; draft handoffs pass 18/18 browser cases, phone audit passes 2/2 classifier and 6/6 browser cases, and preview passes 17/17 original/new cases. A fresh full build and both asset checks pass. Both default suites started with separate scratch homes; `final-after-races-validation-pin.json` records the exact source/test/runtime hashes and runner sessions. The `a4509f1` raw failures and the earlier unclassified phone 401 remain preserved. Source/test/runtime inputs stayed frozen while the suites ran.

The `ef60cf0` unit suite completed with exit 0: 2,158 passed, 13 skipped, no failures or cancellations (2,171 total; 940,191 ms). Its completed log SHA-256 is `f647600e17c7e2da6a43b1365a9c424e9e61e1b5c15332e460d57e1c3a6d78a0`. The browser suite also completed with exit 0: 594 passed, 17 skipped, no failures or cancellations (611 total; 1,804,369 ms). Its completed log SHA-256 is `c1e264f110ad45e2e73ff26ed6a1469856c1943173f28fbc15279be75df25e69`. All source/test/runtime inputs matched the frozen pin throughout both runs.
