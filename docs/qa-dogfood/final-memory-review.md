# Independent late-cluster51 review

Reviewer: `/root/finish_missions`, 2026-10-26. Requested production delta: `9e24117a32bc31c0613da334201c82d97dde7181` against its first parent. The earlier security review did not cover this late commit. Review began from the final daily worktree and checked the exact commit diff; the repair is isolated on `codex/qa-final-memory-onboarding`, based on integration `f7f4765d285f8a176cddd0e396f008505f805873`.

## Outcome

One confirmed P2 correctness regression family: onboarding's new exact-copy elimination reused a whitespace-normalized body-only fingerprint. It omitted accepted guidance with meaningfully different Python indentation, quoted spaces, or branch/path applicability. No additional confirmed security or lifecycle defect was found in the inspected production delta. This is a bounded review, not a claim that arbitrary local worker state or all possible prose is safe or semantically correct.

Parent was notified before production edits and authorized the narrow repair, including the adjacent applicability check. Onboarding now hashes original body text plus applicability and the sorted path set, while existing normalized duplicate-review suggestions stay unchanged. Each section also retains its source's path condition alongside the existing branch condition. No permission, publication authority, ML worker, or provider behavior changes in the repair.

## Confirmed finding and evidence

`src/memory-analysis.ts`, new `retainedBodies` checks introduced by cluster51: `digest()` first applies `text.replace(/\s+/g, " ").trim()`. The following accepted user-authored bodies therefore shared a key:

```python
if ready:
    deploy()
notify()
```

```python
if ready:
    deploy()
    notify()
```

Before the fix, analysis returned one source and an omission reason `Same text as Whitespace 0`, despite different program behavior. Reproduction receipt: `/private/tmp/codeflow-qa-continue/final51-review/whitespace-onboarding.json`. The same failure applies to literal `"left right"` versus `"left  right"`.

The parent independently identified the adjacent body-only scope risk. A scratch Git checkout confirmed that identical current-branch and repository-wide bodies retained only the alphabetically earlier branch source, making the published section appear branch-only. Distinct existing README/config path scopes also collapsed to one source. Receipt: `/private/tmp/codeflow-qa-continue/final51-review/scope-onboarding.json`. Paths are actual applicability gates in both `retrieve` and `resolveSelection`, not merely search ranking hints; the existing UI also says “Applies to.” Prior summaries omitted their path labels, so each source section now states those conditions explicitly, like its existing branch condition.

The repair uses SHA-256 over exact body text, applicability, and sorted paths only for onboarding elimination. It preserves distinct bodies and scoped source revisions, while eliminating an identical copy with identical scope (including equivalent reordered path lists). New tests also assert that normalized review hints remain available.

## Exact production scope inspected

All production files changed by `9e24117` were read, grouped here by responsibility:

- Worker readiness and launch: `scripts/dev.mjs`, `src/ml/transport.ts`, `src/training-worker/python.ts`, and `src/training-worker/main.ts`.
- Snapshot transfer: `src/ml/service.ts`, `src/ml/model.ts`, and the new `upload-status` branch plus existing upload/finish/admission paths in `src/training-worker/main.ts`.
- Search lifecycle: `src/ml/cycle-model.ts`, `src/ml/cycles.ts`, `src/ml/planner.ts`, and `ui/ml/workspace.tsx`.
- Memory and publication: `src/memory.ts`, `src/memory-analysis.ts`, `src/engine.ts`, `ui/memory.tsx`, `ui/memory-analysis.tsx`, and `ui/team.tsx`.
- Statistics and verification: `src/stats.ts`, `src/verification.ts`, and `ui/workbench.tsx`.
- Revision and presentation changes: `src/conventions.ts`, `ui/conventions.tsx`, `ui/lib.ts`, `ui/code-hosts.tsx`, `ui/filesystem-policy.tsx`, `ui/repo-coordination.tsx`, `ui/retention.tsx`, and `ui/shared.tsx`.

Relevant surrounding code inspected: bundle bootstrap/install and hash validation in `src/ml/transport.ts`; `scripts/build-training-worker.mjs`; recipe probing, worker enrollment/locking, snapshot hashing and finalization, upload chunk handling and setup runner in `src/training-worker/main.ts`; service registration/probe/configure/snapshot/job admission and cycle finalization; `src/team-memory.ts`; memory source checks, scope authorization and exact-revision resolution in `src/memory.ts`; bounded semantics in `src/memory-claims.ts`; owner/shared routing and memory analysis/publication routes in `src/server.ts`; filesystem owner gating in `src/filesystem-access.ts`; and `ui/bits.tsx` Markdown rendering. Reviewed the cluster51 issue report, its continuation claims, and focused unit/worker/browser test coverage.

## Boundary and lifecycle conclusions

- Bundle discovery only falls back for default locations and only on absence. Explicit bundle paths stay authoritative. Files/protocol/version are validated before local or SSH installation, and installed contents are hashed again before launch. The dev script builds the bundle before starting the server. Non-ENOENT read failures remain failures. No shell expansion was added.
- Python readiness checks the selected interpreter before package imports. Version output must match Python 3.12.x; missing/nonworking interpreters produce actionable diagnostics. Execution uses an argument array and the worker's restricted runtime environment. Setup uses the same check before venv/pip. The managed recipe environment selection and trust model are unchanged.
- `upload-status` remains inside the worker lock and controller/enrollment check. Hash, format and total bytes are bounded. Oversized or partial trailing chunks are truncated to a retryable offset; complete cached files are checked for both length and full SHA-256. Controller acknowledgements are bounded and advance, resynchronization is limited to one explicit offset mismatch, and clients without resume capability start at zero. Final hash verification still gates inspection and snapshot registration. Hashes are not treated as authorization credentials. Damaged completed snapshots fail closed rather than silently being trusted.
- Search limits are checked before a durable planning claim; the planner is given the current claimed slot and per-trial budget. The allowlist still excludes dataset rows, paths, labels, test metrics, worker logs and credentials. The text-only planner restrictions and output validation remain in place. `cycleLimitReason` correctly treats missing `bestJobId` as no winner, rather than matching a planning-only trial's undefined job ID. Resume rechecks authority/deadline/outstanding work; finalization preserves the selected winner and uses the durable final-job guard to avoid a second final test.
- Run-wide memory aggregation changes provenance references, not prompt bodies. Actual replay still checks project membership, scope, exact live revision, deletion, acceptance, expiry/feedback, applicability and context budgets. Included references suppress only the same id/revision in the union's omitted list. The UI title lookup is project/repository scoped, cannot bypass the owner/shared route separation, cancels stale effect results and falls back to the reference ID.
- Onboarding still limits content to accepted user guidance with trusted user origins and excludes private/run/imported/locked or stale/incomplete sources and earlier summaries. Publication is an explicit owner mutation, recomputes analysis, compares reviewed source revisions and atomically rechecks those sources when proposing the entry. The raw-body fix does not weaken any of these checks.
- Wilson endpoint handling changes numerical boundary noise only. Revision messages retain exact revision checks. Verification evidence uses text-safe fenced output; the UI helper only completes punctuation. Markdown continues to render text without treating it as HTML.

## Validation and limits

- New `test/qa-final-memory-onboarding.test.ts`: Python indentation and quoted-space cases, each with an identical-copy positive control and unchanged normalized review-hint assertion; actual Git checkout checks current-branch/repository distinctions and single/combined/reordered path sets. Together with `test/qa-memory-ml-stats.test.ts`: **9/9 passed**. Log: `/private/tmp/codeflow-qa-continue/final51-review/unit-final.log`.
- TypeScript check passed: `/private/tmp/codeflow-qa-continue/final51-review/typecheck-final.log`.
- New actual-server Chrome replay: `test/e2e/qa-final-memory-onboarding.e2e.ts`. It creates accepted knowledge through the owner API, checks the rendered code and quoted spaces in the onboarding preview, publishes through the UI, inspects the actual `expectedSources` payload and persisted body/source refs, then reloads the saved entry. Final result recorded below.
- Initial browser fixture attempts used an inline-code-only selector and expected a trailing newline. The app renders fenced blocks as `<pre>` without that final newline. Another fixture assertion assumed title order in saved references; storage correctly canonicalizes those by ID. The fixture now inspects both `<pre>` and inline `<code>`, compares all meaningful whitespace, preserves exact analysis/publish request order and checks canonical stored source order. These were fixture failures, not additional product changes.
- Every app/build/test/import execution used explicit scratch `CODEFLOW_HOME`; browser/server child environment also had scratch OS home, a profile-free shell and fake provider CLIs. No live ports, real user repositories, provider calls, package downloads, account changes, or remote mutations occurred. Only owned fixture processes are stopped by cleanup.
- The earlier 118-unit/15-browser cluster validation was not rerun wholesale or claimed as fresh evidence. No real Python package installation/training or real planner behavior was exercised by this review. Existing worker/controller trust and on-disk corruption assumptions remain. Semantic claim analysis is explicitly bounded and grammar-based; it cannot certify arbitrary prose or contradictions beyond its limits.

Final full-app Chrome replay: **1/1 passed**, including eight distinct source revisions, one identical-copy omission, branch/path conditions, actual publication payload, stored content and reload. Log: `/private/tmp/codeflow-qa-continue/final51-review/browser-final.log`. Screenshots, rendered code, full analysis/publication receipts, server log and empty browser-error/HTTP-error arrays are under `/private/tmp/codeflow-qa-final-memory-onboarding/output/playwright/qa-final-memory-onboarding/`. The preview screenshot was visually inspected; code indentation and per-source conditions are visible. The whitespace assertions check DOM text and saved payload; the existing general inline-code CSS does not explicitly preserve repeated spaces visually, which is separate from the deduplication change and was reported to the parent.

Repair commit: `13e7a9655845cda6bc49ad67d56c85778d8f3823` on `codex/qa-final-memory-onboarding`. Worktree is clean and all owned fixture servers stopped.

## Separately authorized inline-code rendering follow-up

The parent authorized the narrow follow-up after the onboarding commit. The new Chrome layout assertion reproduced the existing renderer issue before the CSS change: both `"left right"` and `"left  right"` had width 96.703125px and computed `white-space: normal`. Baseline log: `/private/tmp/codeflow-qa-continue/final51-review/inline-baseline.log`.

The only production change is `.md code { white-space: pre-wrap; }`, retaining inherited wrapping. The extended new onboarding browser regression passed: one-space width 96.703125px versus two-space width 103.921875px; both code fences retained their exact content and computed style; the long inline literal wrapped onto five lines at a 390px viewport. Markdown content width and scroll width were both 309px, and document width matched the 390px viewport. Desktop width and scroll width also matched. The test still performs actual publication and reload (now including the ninth long-literal source).

Evidence: `/private/tmp/codeflow-qa-final-memory-onboarding/output/playwright/qa-final-memory-onboarding/code-layout.json`, `preview-narrow.png`, `preview.png`, and empty `browser-errors.json`. The narrow screenshot was visually inspected. **1/1 Chrome** and TypeScript passed: `inline-fixed.log` and `inline-typecheck.log` under the review evidence directory. No other production changes or additional real provider calls.

Separate follow-up commit: `9ec26b5e3501081ed5bda9b7b7a520640866adf8`. Worktree clean; owned browser and fixture server stopped.

## Independently confirmed literal applicability labels

The final independent reviewer reproduced a P2 in the new inline JSON-quoted path labels: JSON quoting does not escape Markdown. `[config](notes).txt` became visible `config.txt` with a link instead of the filename. The analogous existing `_qa_` branch label became emphasis. Receipt: `/private/tmp/codeflow-qa-continue/final-memory-review-probe.json`. Parent authorized both adjacent label repairs.

Path lists now render as fenced JSON arrays; branch/commit applicability renders as a fenced JSON string. Embedded line breaks are JSON escapes, so embedded backticks cannot form a closing-fence line. Labels preserve their exact values instead of interpreting Markdown punctuation. The path list also removes duplicate identical normalized paths. Deduplication, authority, source checks and content bounds are unchanged.

New QA unit and actual-server Chrome regressions use tracked `[config](notes).txt`, single/triple-backtick filenames, and a filename containing newlines and a triple-backtick fragment. The browser uses an actual `_qa_` Git branch and pinned commit, verifies exact code-block JSON, zero links and zero emphasis, and preserves all eleven source revisions in the published entry. Inline spacing/wrapping and fenced-code checks continue to pass. **18/18** focused plus original memory-analysis tests, TypeScript, and **1/1** extended Chrome replay pass. Logs: `/private/tmp/codeflow-qa-continue/final51-review/path-branch-{unit,typecheck,browser}.log`. Current `rendered-code.json`, `code-layout.json`, `publication.json` and empty `browser-errors.json` are in the final-memory Playwright evidence directory. No shared tests were edited. All executions used explicit scratch homes; fixture servers stopped.

Literal-label repair commit: `e57a7593baffcc6a74af489c7c548e3ec4c5e5d2` on `codex/qa-final-memory-onboarding`; worktree clean.
