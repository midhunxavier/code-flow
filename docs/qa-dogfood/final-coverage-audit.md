# Read-only final partial-coverage audit

Audit began against integration `62af746`; the worktree inventory was later captured against `481f886`. Reports can advance during final integration, so findings below identify the inspected wording rather than claiming a current broad-suite result. No integration or active-worktree file was edited.

## Accounting result

- The tracked archive contains 508 historical feature records. Filtering original `partial`/`blocked` yields exactly 53 IDs: 52 partial plus COL-04 blocked.
- The final table has exactly those 53 unique IDs, no omissions or extras, and counts 40 Gap replayed / 12 Partial / 1 Blocked. All relative report links resolve.
- The table explicitly avoids claiming 508 fresh replays. Final integrated collaboration cases 181–192 were independently located as passing in the first broad log; that entire run is not described as green.
- Daily final16/16, Team4/4, collaboration6/6, opt-in SSH+ML2/2, Git9/9 and candidate15/15 counts agree with their lane logs. The later combined phone2-pass/1-opt-in-skip is kept separate from the earlier actual SSH pass.
- No material status inflation found. Real Team send remains queued after reload, actual recipient consumption is unproven, native/real-platform limits remain explicit, the AGY URL request is honestly unreachable before the fake runtime gate, and the initial failed real Team is preserved.

## Narrow wording findings sent to parent

1. **PLAT-31 local positive controls:** six paired-phone endpoints receive403, but only the first four (`capabilities`, `settings`, `summary`, `state`) are checked locally for200. `qa-final-partials-ml-boundaries.e2e.ts` explicitly uses `paths.slice(0,4)`. The Team/ML lane phrase “Corresponding local owner endpoints200” is too broad; qualify four local controls. The consolidated row is ambiguous rather than explicitly wrong. No coverage status change required.
2. **SHL-20 appended pagination method:** actual seen root/fork/side counts and filters have Chrome coverage, but105-item pagination is in `test/qa-final-approval-attention.test.ts` (unit/API-query fixture), not the Chrome replay. The linked approval report is exact; qualify the appended consolidated-table phrase so its Live fixture label does not imply105 browser tasks.
3. **RUN--GAP-02 second shutdown:** the row groups PID/boot/second-shutdown limits as deterministic safety-test boundaries. The inspected test suite has the deterministic mismatched-PID guard in `foundation.test.ts`; no second-signal test was located. Keep second Ctrl-C and live reboot explicitly untested instead of implying focused test coverage. The row is already Partial.
4. **Real Team call-count scope:** `team-child.json` has3 agent steps and1 check; `team-run.json` parent has1 additional Claude explanation step. The daily report already distinguishes them. The evidence-index phrase “retry's three Haiku/low calls” should say “Team child3 plus parent explanation1” to avoid implying3 total paid invocations. No result/status change.

Parent acknowledged and is applying wording qualifications separately. This audit made no report edits and did not rerun applications or providers.

## Preservation result

See `final-worktree-preservation-proposal.md` and machine-readable inventories beside it. Five verified archives now preserve four completed lane outputs and the complete delta-review checkout (excluding `.git` and `node_modules`, with symlinks unfollowed), including its two untracked probes. The delta HEAD is pinned with a private recovery ref. Active memory and integration were excluded; no worktree was removed. All archives and private ref received an independent final hash check.
