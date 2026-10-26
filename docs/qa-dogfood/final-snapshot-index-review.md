# Final Git snapshot detection and staging review

## Confirmed production defects

The frozen full unit run at `0129dac6cc4d81d39d5c862df0e52b74724b3994` failed the existing snapshot-warning assertion in `qa-side-notes-terminal.test.ts`: a same-size tracked edit to README.md was omitted. The one authorized unchanged whole-file replay passed 7/7 in 431.64 ms; that timing-sensitive pass does not invalidate the original failure. The original log and replay filesystem/index states are preserved separately.

A controlled default Apple Git 2.39.5 reproduction (no special Git configuration) confirmed the cause. The original index and same-size edit occurred in the same timestamp second, then snapshot comparison ran in the next second. Native Git detected README.md while CodeFlow `changedSince` returned `[]`. Copying the index gave it a fresh timestamp, disabling the original index's racy-entry safeguard. The real index bytes and source content remained unchanged during this read-only probe.

Two independently confirmed staging defects were repaired in the same bounded snapshot area: restoring a snapshot used `stash apply` without `--index`, which dropped the original staged/unstaged split; and comparing only working-tree trees missed stage-only/unstage-only mutations. The independent reviewer also reproduced both in linked worktrees. These are production defects, not weakened test expectations.

## Changes and scope

- Commit `cb2692f`: read the original index timestamp before copying it and set the private copy to a conservative whole-second floor from exact bigint nanoseconds before refresh. Only the private copied index is modified. Bigint conversion avoids floating-point rounding that can move a timestamp one nanosecond into a newer second.
- Commit `20b70da24631477e0ad61c7132edc500a77a22bd`: derive working-tree and index trees from the same captured stash; use HEAD's tree for a clean capture. Preserve existing commit/content warning wording and report `staging: <paths>` when only staging changed. Restore via the existing reset followed by `stash apply --index`.
- No live app, user repository, remote, push, or real home was used. Every importing/test command had an explicit scratch CODEFLOW_HOME; runtime tests also used scratch HOME/ZDOTDIR. The fixture uses fake local repositories only.

## Validation

- New corrected regression against unchanged production: 0/2, independently confirming the racy-index false negative and loss of the saved staged tree. `final-snapshot-corrected-baseline.log`.
- Timestamp-only fix: first regression passed; the mixed-staging regression still failed at the exact saved-index-tree assertion. `final-snapshot-timestamp-only.log`.
- Whole candidate: 5/5 new regression cases pass. They cover same-size edits; staged, unstaged and partially staged content plus untracked restoration; stage-only; unstage-only; unchanged controls; and working tree equal to HEAD with a different staged version. Inspection checks real index bytes and mtime unchanged.
- New5 + original side-notes7 + Git reliability12: 24/24 pass in 8.23 seconds. Original assertions are unchanged. Held locks, concurrent snapshot calls, linked-worktree identity protections, binary untracked content and filter independence remain covered. `final-snapshot-related.log`.
- TypeScript typecheck passes. `final-snapshot-tsc.log`.
- Fixed default-Git original clock-boundary reproduction detects `edits: "README.md"`, leaves the edited file in place, and preserves real index bytes. `final-snapshot-controlled-fixed-receipt.json`; original failing receipt remains `final-snapshot-controlled-receipt.json`.

## Evidence

Central directory: `/private/tmp/codeflow-qa-continue/`.

- `final-snapshot-frozen-failure.txt`: bounded original full-unit failure.
- `final-snapshot-unchanged-replay.log`, `final-snapshot-unchanged-state/`, `final-snapshot-replay-git-trace.jsonl`: the single unchanged replay and preserved state.
- `final-snapshot-controlled-probe.mjs`, `final-snapshot-controlled-receipt.json`: original default-Git deterministic reproduction.
- `final-snapshot-controlled-fixed-probe.mjs`, `final-snapshot-controlled-fixed-receipt.json`: fixed reproduction.
- `final-git-index-precision-probe.json`: independent float rounding counterexample and safe bigint floor.
- `final-git-index-baseline-probe.json`, `final-git-index-staging-only-baseline.json`: independent linked-worktree and staging-only baselines.

Candidate worktree `/private/tmp/codeflow-qa-final-snapshot-index-fix`, branch `codex/qa-final-snapshot-index-fix`, based on integration `18615234897819c143de0bce809eca3b6183a08b`. Both commits are complete and the worktree is clean. Independent candidate review passed at the exact committed source fingerprint; see `final-git-index-review.md`. These focused checks do not claim the full unit/browser suites passed; parent owns the subsequent frozen full validation.

## Reproducible focused commands

From `/private/tmp/codeflow-qa-final-snapshot-index-fix`:

```sh
CODEFLOW_HOME=/private/tmp/codeflow-qa-continue/final-snapshot-related-home HOME=/private/tmp/codeflow-qa-continue/final-snapshot-replay-os-home ZDOTDIR=/private/tmp/codeflow-qa-continue/final-snapshot-replay-os-home node --import tsx --test test/qa-final-snapshot-index.test.ts test/qa-side-notes-terminal.test.ts test/git-reliability.test.ts
CODEFLOW_HOME=/private/tmp/codeflow-qa-continue/final-snapshot-tsc-home HOME=/private/tmp/codeflow-qa-continue/final-snapshot-replay-os-home ZDOTDIR=/private/tmp/codeflow-qa-continue/final-snapshot-replay-os-home npm run typecheck
```

Committed source SHA256: `eba800b399c29050233cf887d241d4c0a70eb40804a351a93a3f0af9a5149b41` (`src/git.ts`). New regression SHA256: `c40b830e7e05241912e9adeb094bb880bae1bc29742d304a909569272e97c9cb`.

## Final independent review

The separate reviewer reproduced the original missed edit and lost staging in a linked worktree, then passed the same probes on the committed candidate. Parent-checkout dirty content stayed unchanged. Read-only inspection preserved index bytes/mtime, restore preserved cached/uncached binary diffs and prior untracked contents, new untracked files were removed, all three staging-only cases passed, unchanged controls caused no index writes, and no copied index/lock files leaked. Receipts: `final-git-index-candidate-probe.json` and `final-git-index-staging-candidate.json`.

No new blocker remains in this reviewed delta. Runtime validation here is macOS with actual Git; Windows/Linux execution was not performed. External concurrent Git writers and the existing absent-index/copy-failure fallback remain outside this bounded change. Parent owns the subsequent full-suite run.
