# Final memory correctness review

Read-only review of `13e7a9655845cda6bc49ad67d56c85778d8f3823` in `/private/tmp/codeflow-qa-final-memory-onboarding`, plus adjacent CSS commit `9ec26b5e3501081ed5bda9b7b7a520640866adf8`. No production or test files in that worktree were edited.

## Final repair verification

**Resolved by `e57a7593baffcc6a74af489c7c548e3ec4c5e5d2`; no remaining finding in the reviewed delta.** Independently reran the original store→analysis→actual Markdown renderer probes against the committed repair, extending them to bracket/parenthesis, single and triple backticks, embedded newline/fence text, quotes, Unicode, bold and italic punctuation. The fenced JSON path list round-trips to the exact stored paths; no anchor, italic or bold elements are produced. The actual `_qa_` branch is likewise retained literally in its fenced applicability annotation. Normalized-path deduplication and distinct commit applicability still pass. The new path label also removes repeated normalized paths from display.

Independent rerun: **18/18** targeted tests passed (`final-memory-review-tests-after.log`), and all direct probes passed (`final-memory-review-probe-after.json`, `final-memory-review-probe-after.stderr`). The original failing receipt is preserved as `final-memory-review-probe-before.json`. The production change only changes applicability formatting; scope, eligibility, source identity and publication guards remain unchanged. JSON escapes embedded line breaks and quotes, so arbitrary path/branch backticks stay inside quoted strings rather than becoming fence delimiters. The implementing agent's expanded Chrome test additionally checks exact preformatted content and publication; this lane did not rerun that browser suite.

One nonblocking test observation: its `.md em` count alone would not catch this renderer's italic `i` elements, but the exact fenced-content assertions already catch the original branch failure, and this independent probe explicitly rejects both `i` and `em` (plus bold/anchors). No production change is requested for that observation.

## Actionable finding

**P2 — new path applicability labels are interpreted as Markdown.** At `src/memory-analysis.ts:194`, wrapping a path with `JSON.stringify` does not protect Markdown punctuation. An actual tracked scratch filename `[config](notes).txt`, accepted through `MemoryStore.propose`, passes freshness checks and is included in onboarding. Its generated label is `Applies to paths: "[config](notes).txt".`, but the application's actual `markdownNodes` renders visible `Applies to paths: "config.txt".`. The label therefore identifies a different path. This is a display/applicability error, not a demonstrated execution or authorization bypass.

Recommendation: emit path applicability using a literal-safe representation, such as a fenced JSON list, and test the renderer with brackets/parentheses, backticks, quotes and Unicode. The existing new tests use ordinary filenames and miss this case. Parent has assigned this repair to the implementation agent.

**Confirmed adjacent preexisting branch-label limitation:** a real scratch Git branch `_qa_` is accepted and selected correctly, but `Applies to branch _qa_.` renders as `Applies to branch qa.`. That annotation predates this delta; it is reported separately to avoid attributing it to the new deduplication change. A shared literal-safe applicability formatter can address it if included in the narrow repair.

Reproduction source: `final-memory-review-probe.mjs`; result: `final-memory-review-probe.json`; stderr: `final-memory-review-probe.stderr`, all under `/private/tmp/codeflow-qa-continue/`. The probe uses a new scratch Git repository and SQLite database, the actual MemoryStore/analysis functions, and the actual Preact Markdown node generator. It does not claim a browser replay for the punctuation case.

## Checks that passed

- Exact stored body identity now retains semantically different Python indentation and quoted spaces; the normalized text digest remains only a duplicate-review hint. Eligibility/freshness/contradiction gates still precede retention, so an ineligible duplicate cannot suppress eligible guidance.
- Stored applicability is canonicalized by MemoryStore. The new hash includes repository/branch/commit applicability, and an independent two-commit probe kept both otherwise identical eligible branch entries.
- Paths are normalized by MemoryStore; the new set-and-sort identity deduplicates order and repeated paths. An independent store-level probe using `folder/` and `folder\\` versus `folder` produced one onboarding source as intended. The first stored entry can contain duplicate normalized path strings, so its current label repeats `folder`; this is redundant display, not lost applicability.
- The existing 12-entry/12,000-character limits include added applicability text. Source references continue to identify the retained entry, and publication rechecks the current analysis sources plus the store's atomic source revisions.
- **17/17** targeted tests passed: new onboarding regressions, `memory-analysis.test.ts`, and `qa-memory-ml-stats.test.ts`. Log: `final-memory-review-tests.log`.

## CSS follow-up review

No additional finding in `9ec26b5`. `.md code { white-space: pre-wrap; }` is limited to Markdown code spans; the current fenced-code renderer emits `pre` directly. The added browser assertions test rendered width for single versus double spaces, the computed whitespace rule, wrapping of a 180-character literal at a 390px viewport, both content and document overflow, and unchanged fenced text/style. Those geometry checks address the prior textContent-only coverage gap. This lane reviewed their source and the production selector; the implementing agent's browser result was not relabeled as an independent rerun.

All importing/testing commands used explicit scratch `CODEFLOW_HOME`. Only scratch repositories and databases were created; no live paths, services, user repositories, remote effects or worktree edits were used.
