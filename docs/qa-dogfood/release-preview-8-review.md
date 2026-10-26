# Preview 8 PR review follow-through

PR: https://github.com/midhunxavier/code-flow/pull/61

The release branch starts at `f14f404` and carries the final QA tree without the raw `docs/qa-dogfood/data` archive or its branch history. The full continuation branch and local evidence remain preserved. Publication is a subsequent user-authorized task; the original QA closeout's no-publication statement describes that earlier checkpoint.

## Product findings

Automated PR review found that native approvals appeared in the main app's attention state but not the read-only phone view. The phone list now uses the shared attention predicate; list and detail badges show pending native approvals, and the detail explains where to answer. Detail rendering reads live approval state without persisting it or granting control.

Both new Claude/Codex rendering cases failed before the repair. They pass after it, together with 43 related approval, phone, Team, automation and project checks (45 total). Resolution clears the badge, stopped/archived runs do not inherit obsolete approval attention, and the page exposes no approval form, button or mutation route.

CI also reproduced an archived-run cache scheduling race. When an update invalidated an in-flight cache save, its replacement request was discarded because the save was still pending. The run could remain permanently hot. Scheduling now coalesces updates into one replacement write; the original promise includes that replacement so shutdown awaits it. Two held-write regressions fail before the repair and pass afterward, alongside the original storage/cleanup file (18 checks). The original archive-state deadline was restored; increasing it had not repaired the defect.

## CI and fixture findings

- Hard-coded macOS temp paths and Chrome locations were replaced with canonical platform temp paths and Chrome detection. All 61 affected unit/UI cases pass locally; assertions remain intact.
- A new browser regression selected Playwright's uninstalled default browser when no explicit executable was supplied. It now uses installed Chrome in that case.
- macOS CI and release-package tests now use the same isolated mock-keychain Chrome wrapper as final local QA. Full-suite job windows increased to account for the expanded suite: unit 40 minutes, browser 45, release package 45. Browser acceptance is split deterministically across three independent jobs, with every file selected exactly once and per-job concurrency unchanged. Tests and required checks remain enabled.
- Route removal waits for held handlers. Terminal visible-text comparisons remove only invisible systemd OSC 3008 context in addition to their existing bracketed-paste normalization.
- Preview fixtures wait for actual navigation completion before stopping a newly opened preview, and use the UI queue when testing UI tab changes. API-only replacement checks close their UI first. The strict browser-error audits remain enabled; unclassified errors are not generally accepted.
- The long-path layout fixture now guarantees its required path length on Linux. Phone launch shims record working directories so Linux's no-argument terminal launch is verified correctly. Conflict-resolution failure uses a fake Codex write turn, avoiding dependence on macOS-only Antigravity isolation.
- The deliberately offline worker's console error must match a real 400 POST response from that page and the fixture's exact offline diagnostic. Unrelated responses and unmatched/duplicate errors still fail.
- Cold-store and frame tests use bounded waits for their actual state. Mission history checks scope the expected text to the opened history. Automation/mission failures retain screenshots and page text for future diagnosis.

The first Linux jobs failed, and the first macOS/browser jobs exceeded the old time limit. Their raw logs and browser artifacts remain under `/private/tmp/codeflow-qa-continue/release-ci-*-first.log` and `release-ci-browser-evidence/`. The transient automation-picker and mission-history failures passed their unchanged local file replays; that does not prove the causes of those original events.

## Focused verification

In addition to the original frozen QA totals, release follow-through passed typecheck, installed-package tests (12), publishing-contract tests (8), portability checks (61), approval/phone checks (45), refined preview/UI checks (22), offline-worker/daily checks (16), cold-store/frame/terminal checks (21), merge checks (2), the mission-engine browser file (6), and the new cold-cache scheduling/storage cases (18). These use isolated homes/repositories and fake providers. Current-head GitHub CI is the final merge gate; these focused passes do not recategorize earlier raw failures.

The QA report's 12 partial features, one blocked feature, original unclassified phone 401 and historical possible home-registry write remain qualified.

Later CI receipts additionally exposed hydration, platform select-all, desktop VM startup-event ordering and settings navigation timing in test fixtures. Their corrections retain the content/visibility assertions and wait for the actual readiness condition. Original raw failures remain preserved.

The saved macOS job also showed a paused-watchdog fixture measuring its pause before child startup, and a multi-stage SSH fine-tuning case exceeding its overall 30-second test cap. The watchdog fixture now resumes on a child event while preserving its production watchdog thresholds and cancellation check. The SSH case has a 90-second overall test cap; operation limits remain unchanged. Both focused cases and typecheck pass locally (`release-macos-timing.log`, `release-macos-typecheck.log`).

## Final browser review follow-through

The `357fda3` run passed browser group 0, desktop/installer/provider/docs checks and the Ubuntu release-package gate, but the remaining browser groups and unit jobs exposed further release blockers. Their raw receipts are `release-final-browser-{0,1,2}.log`, `release-final-node{22,24}.log`, `release-final-macos.log` and `release-final-package-macos.log` in the scratch evidence root. These failures remain recorded.

The mission page discarded live snapshots received before its initial inventory, then let the older HTTP response restore a cleared error. It now retains those snapshots, overlays updates received during a load, and rejects superseded loads. A controlled stale-inventory browser case fails before the repair and passes afterward; all seven mission cases pass locally.

The browser also had an unguarded discovery path for already-running previews. Discovery now records an intent in its existing scope, so the normal cancellation checks cover it and an older render cannot replace a newer intent. Navigation controls queued behind a resize use the current view of the same tab; pointer input remains tied to its observed view. Viewport changes wait for an active pointer gesture to finish, avoiding a drawer/layout change invalidating an annotation drag. A held-resize Reload case returns 400 before repair; a controlled gesture changes its view mid-drag before repair. Both pass with the repairs, alongside all six side-browser cases. The original and added preview-cancellation scenarios pass (seven cases).

Cookie-transport tests now change principals on an inert same-origin fixture document, keeping unrelated app polling out of those cookie assertions; actual sign-in, handoff and sign-out checks remain. Phone ports stay reserved until their listener is enabled, and the handoff asserts the HTTPS listener's readiness. Filesystem-policy read tracking settles on received headers after the server's protected work, retaining its policy assertions. Deleted-run console 404s are classified only when a matching same-origin GET response targets chats or app status for a run whose DELETE actually succeeded; each response accounts for at most one console event. Other errors continue to fail.

Some local preview replays initially omitted the macOS scratch-home Chrome wrapper and stalled in real navigation. The same seven cases pass with the mock-keychain wrapper already used by CI. Those unsuccessful local receipts are retained separately; they are not counted as passing verification. Final-current-head CI and release builds remain required before merge/publication.

The completed follow-through replay passes all 38 affected browser cases with the CI Chrome configuration, followed by typecheck, release preparation and all 12 installed-package checks. The discovery regression also fails against the prior source with that wrapper: navigation reaches the stopped target and receives `ERR_CONNECTION_REFUSED`. Controlled baseline scripts restored the current source bytes afterward, verified by SHA-256 receipts. Final CI/builds must validate this reviewed tree before publication.
