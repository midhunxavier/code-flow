# Independent review: side-notes restart audit

Reviewed `4edf5a489c182a85b80f731d1e11fe22cf1730d3` and its corrective commit `7fff3f99e1c09cee00b0a5c86e74553754f02b4d`. Final source SHA256: `58ce203ec15b181dda388f5ee667086d3b6e4beff4e443c1899d44841274f360`. Review was read-only: no browser, app, or tests launched; no source edits.

**No remaining actionable code finding after7fff.** The original seven browser scenarios and their behavior assertions are intact; the eighth case is the audit classifier regression. Existing page/console error assertions remain and teardown audits late events. Scope is recorded owned-origin API request outcomes plus observed console errors; this is not a claim that every external network request is instrumented.

## Finding and correction

In4edf, `networkAudit` inspected a failed request only if its code matched the expected transport allowlist. Consequently a recorded `net::ERR_TIMED_OUT` without a console event produced empty audit errors, although `expectedFailure` returned false. The negative probe checked only that predicate, so it did not catch the actual audit gap. This was reported to root and the fixture owner.

7fff audits every recorded nonempty request failure; a missing errorText is represented explicitly as `Unknown request failure`. Unknown failures remain errors without console output. HTTP and transport outcomes are classified independently, so an accepted shutdown503 cannot conceal a subsequent unknown transport failure. The console pairing uses the corresponding transport-only observation when matching a network code.

The new negative checks call the actual audit with no console message for TIMED_OUT, NAME_NOT_RESOLVED, ABORTED and unknown text, including records that also contain an otherwise expected shutdown response. No broad cancellation exemption was added. Existing negatives still cover request lifetime outside restart, at/after readiness, missing observation, wrong/missing body, wrong status, arbitrary POST, unrelated origin, malformed stream IDs, later same-URL failures and unmarked offline notes requests.

## Classification boundaries

Expected shutdown HTTP remains restricted to the owned API origin, a finite observed request lifetime overlapping the stop-to-ready window, status503 and the exact `{"error":"The backend is stopping"}` body. Methods are GET and the demonstrated24-hex stream subscription POST. Other writes are not accepted as shutdown HTTP. The explicit offline notes POST is marked on that exact request. Unmatched console errors fail; response bodies that cannot be read within the bounded interval fail closed.

These are fixture observation boundaries, not proof of every historical error's cause. Timestamp overlap and console pairing are browser-event observations. The old captured trace includes an ERR_ABORTED whose intentional cause was not established; the corrected audit deliberately leaves it unexpected. The historical clean reclassification under4edf must not be presented as a clean result under7fff.

## Evidence checked

- Final whole file: 8/8 passed, 0 failed, 0 cancelled, 0 skipped; Node duration56.650s, outer result exit0. This is seven original scenarios plus the negative audit probe.
- Final browser receipt: pageErrors `[]`, consoleErrors `[]`,36 expected request/console entries. Recorded request failures were one explicitly offline request,13 connection refusals and4 incomplete streams. No unknown cancellation or HTTP503 occurred in this final run; exact503 classification is supported by the earlier recorded trace and deterministic negative/positive controls, not invented fresh browser evidence.
- Final typecheck passed and the worktree is clean. Source/receipt files: `final-side-notes-audit-all-failures/`, `final-side-notes-audit-fix.md`, and `final-side-notes-audit-review-static.json` under this QA root.

The owner's appended report correction accurately supersedes the earlier4edf clean-trace claim. Recommended presentation cleanup is to label that initial report section as historical4edf so its older “final helper” wording cannot be mistaken for7fff.
