# Final pending-approval routing race

The frozen full E2E run failed SHL-20 while waiting for a side panel. A separate unchanged whole-file replay at production base `cd93ad1` passed all 16 cases, so the broad failure was timing-sensitive. Source review then found a specific cross-topic ordering gap: `taskNeedsYou` recognized the authoritative `RunSummary.approvalPending` field, but `waitingForUser`, used for click routing, recognized only workflow/team requests and the separate ApprovalInbox payload. A family could therefore be known to need attention while its click selected the previously viewed main chat and left the waiting side chat closed.

The new regression isolates that product boundary from fixture readiness. It holds only the actual approval topic's snapshot payloads in the browser, permits normal run/history delivery, and waits until the side summary is explicitly observed with `approvalPending: true` before clicking its family. On unchanged production code it fails with the same Side panel visibility timeout and no browser errors. The successful run records the known summary and authoritative counts before the click, shows the side panel while the payload is still held, then releases the payload and checks the question card. It also exercises delayed-payload fork/root routing, cancellation, and unrelated-family last-viewed fallback.

The production repair adds `chat.approvalPending === true` to the existing running-chat wait predicate in `ui/rail.tsx`. It retains the native approval-payload fallback for older hosts. It does not treat arbitrary unseen/finished results as pending questions, alter approval authority, or change side-panel visibility independently of an explicit navigation click.

Validation on `codex/qa-final-pending-routing`:

- New deterministic Chrome replay: baseline fails at the side-panel wait; repaired version **1/1 passes**, with browser errors `[]`.
- Related attention/count/history tests: **11/11 pass**.
- TypeScript `--noEmit` and `git diff --check` pass.
- Original whole daily file: **16/16 passes before the change** and **16/16 passes after the repair** (85.6 seconds), including the original SHL-20 case and the no-unclassified-console-errors assertion.

Evidence under `/private/tmp/codeflow-qa-continue/`: `pending-routing-daily-baseline.log`, `pending-routing-baseline2.log`/`pending-routing-baseline2/`, `pending-routing-fixed.log`/`pending-routing-fixed/`, `pending-routing-daily-fixed.log`, `pending-routing-related.log`, and `pending-routing-tsc.log`. The new Chrome receipt records `hold: true`, a blocked approval payload, the side summary's true flag, and matching server counts before navigation. The original daily test was not weakened or synchronized around the missing signal. This diagnosis proves the known-summary/delayed-payload product race; it does not assume that every immediate API-created-child click already has a loaded UI summary.

All execution used explicit scratch `CODEFLOW_HOME`, scratch repositories, fake providers and reserved loopback servers. The ongoing integration full suite, live services and user repositories were not changed.
