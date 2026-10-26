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
