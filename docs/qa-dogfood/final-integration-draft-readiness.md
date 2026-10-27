# Connections draft handoff readiness

## Confirmed failure and cause

Frozen integration `a4509f143f99206576b113418c81e98e66eea9f5` recorded browser failure310 in the unchanged `qa-integration-connections.e2e.ts`: after importing a Jira issue, its Task field did not appear within15 seconds. The captured page remained on Connections and showed “The project draft is still loading. Try again.” Browser errors were empty.

Exactly one unchanged whole-file replay reproduced the same Jira failure:11/12 passed,1 failed, no skips,72.47 seconds. It used a fresh scratch checkout/home, reserved loopback ports, fake providers/code hosts, the QA Chrome configuration and diagnostic Playwright trace/API logging. Tested source and assertions were unchanged. Original and replay artifacts were preserved separately before subsequent builds.

This is a product readiness race. The app renders project services before asynchronous draft initialization finishes. Connection preview buttons were enabled on the local request state alone, but `openComposer` returns false until `draftsReady`. A normal click could therefore be refused without navigating, even though the button looked ready. Existing New run and Scheduling controls already gate on `draftsReady` and `composerLoading`.

## Repair

The issue, PR-review and failing-CI preview handoffs now use those same readiness signals. They remain disabled while restoration is pending, show “Restoring your project draft…” next to their actions, and recheck readiness in the click handler. Once ready, the existing handoff and error paths run unchanged. Listing/importing source material, real failures, provider choices and draft semantics are not relaxed.

Production change is limited to `ui/integration-connections-view.tsx`. The original12-case integration-connections browser file is byte-identical to the frozen source (SHA256 `4664c3213a86f469eebdaf5d6da5226666d9949ceee64e7632bc10a8a61950ac`). No integration/source/runtime input was modified while the parent full suites ran.

## New regression and validation

New file: `test/e2e/qa-final-integration-draft-readiness.e2e.ts`.

It deliberately holds the real boot inventory dependency before `initializeProjectDrafts`, while the actual Connections UI loads. GitLab, Linear, Jira, GitHub PR and GitHub failing-CI pathways must show a visible in-viewport restoration status and disabled draft actions; stored task/criteria are unchanged. Releasing the dependency enables the action, one click opens the selected workflow/source, and reloading preserves the newly selected draft rather than restoring stale content. The final case checks browser/server errors.

- Corrected deterministic baseline against unchanged production: all5 handoff cases fail because their button is enabled too early; the log audit passes. Total1/6 passed,5 failed,17.80 seconds.
- Fixed new6 plus unchanged original12 browser cases:18/18 pass, no skips,61.75 seconds. Existing failure/Retry assertions remain intact.
- An added viewport assertion and screenshots then pass the final new6 cases in21.86 seconds. The restoring message and disabled PR/CI controls were visually inspected.
- Related unit checks (`qa-integration-connections`, `project-drafts`, `qa-composer-draft-config`):13/13 pass.
- Typecheck and diff whitespace validation pass.

The first development version of the new regression exposed two fixture-only problems: unregistering a held route before its handler finished, and assuming a server log file exists when no events were logged. Both were corrected before the clean baseline/fixed results above. Those development logs are retained; they are not counted as product failures or passing validation.

## Evidence and limits

Central root: `/private/tmp/codeflow-qa-continue/final-integration-draft-replay/`.

- `frozen-failure.txt`, `frozen-evidence/`, `frozen-evidence-manifest.json`: original full-suite failure and11 artifacts.
- `unchanged-replay.log`, `replay-browser-events.jsonl`, `replay-*.zip`, `unchanged-evidence/` and manifest: single unchanged replay with10 captured app artifacts and trace.
- `new-baseline-corrected.log`: deterministic baseline5 failures, clean audit.
- `final-browser.log`, `visible-browser.log`, `related-unit.log`, `tsc-final.log`: candidate verification.
- `fixed-readiness-evidence/`, `fixed-original-evidence/`, `fixed-evidence-manifest.json`:16 preserved final screenshots/logs with hashes.

No real provider execution, external publication, user repository, live home or live ports4317/4318 were used. All test/build/import commands supplied an outer scratch CODEFLOW_HOME and scratch HOME/ZDOTDIR. Parent owns independent review and final integration. These focused results do not turn the already recorded full-suite failure into a pass.
