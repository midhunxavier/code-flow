# Final owned QA checkout cleanup

Completed all final authorized removals. The original registered-removal baseline was102; these four registered removals bring the total to **106**. The current registry went **21 → 18 → 17**. Two unregistered diagnostic copies were removed separately and are not part of the106 total.

Every removal followed a fresh full source-manifest comparison, archive/manifest SHA256 check, clean expected HEAD/status, integration ancestry, and absence of process CWDs. Registered paths were removed with ordinary `git worktree remove`, without force, process kills or branch deletion. All four branch refs and all six recovery archives remain and were rechecked after cleanup.

## Four registered mappings

- Removed `/private/tmp/codeflow-qa-final-side-browser-fix` at `1b763cbef98bfc97d5fcf3d6c5313002014d41d1`; retained branch `codex/qa-final-side-browser-fix`.
  Recovery archive: `/private/tmp/codeflow-qa-continue/final-owned-fixes-recovery/codeflow-qa-final-side-browser-fix/checkout.tar.gz`.
  SHA256: `d414a4706ce1cd128c011baa663239a2f542b1bc745af8c66da005669685623b`.
- Removed `/private/tmp/codeflow-qa-final-browser-timing-fixes` at `c1560958bd347d9d0e43127c64c4a3821c16318d`; retained branch `codex/qa-final-browser-timing-fixes`.
  Recovery archive: `/private/tmp/codeflow-qa-continue/final-owned-fixes-recovery/codeflow-qa-final-browser-timing-fixes/checkout.tar.gz`.
  SHA256: `b0b12f481b057ad6b11ef28e9b6a3ee7d64b2b0d7f62422ab9138086c599d999`.
- Removed `/private/tmp/codeflow-qa-final-snapshot-index-fix` at `20b70da24631477e0ad61c7132edc500a77a22bd`; retained branch `codex/qa-final-snapshot-index-fix`.
  Recovery archive: `/private/tmp/codeflow-qa-continue/final-owned-fixes-recovery/codeflow-qa-final-snapshot-index-fix/checkout.tar.gz`.
  SHA256: `d828226d61ef07d73a419d9fc5fb3a76170ca3caa70efe39d56d3c74e8566a47`.
- Removed `/private/tmp/codeflow-qa-final-side-notes-audit` at `7fff3f99e1c09cee00b0a5c86e74553754f02b4d`; retained branch `codex/qa-final-side-notes-audit`.
  Recovery archive: `/private/tmp/codeflow-qa-continue/final-side-notes-recovery-7fff3f9/codeflow-qa-final-side-notes-audit/checkout.tar.gz`.
  SHA256: `f01e4a8e2b201eec38b4519b72f3088841f4e6cc29461661720e51abdf6b66b6`.

## Two unregistered copies, counted separately

- Removed `/private/tmp/codeflow-qa-final-start-input-5wnbkavc` (9e4a7f1 git archive plus diagnostic outputs).
  Recovery archive: `/private/tmp/codeflow-qa-continue/final-owned-fixes-recovery/codeflow-qa-final-start-input-5wnbkavc/checkout.tar.gz`.
  SHA256: `571c7f4998d7d0be12d859993bf38ea47431f0611e1524faefcff9d80f6976a3`.
- Removed `/private/tmp/codeflow-qa-final-snapshot-hr8cotk_` (0129dac6cc4d81d39d5c862df0e52b74724b3994 git archive plus new baseline regression).
  Recovery archive: `/private/tmp/codeflow-qa-continue/final-owned-fixes-recovery/codeflow-qa-final-snapshot-hr8cotk_/checkout.tar.gz`.
  SHA256: `8dc67746ec5bc2e77812704f659537dd6b092b67a94b33d74e8e7abd3477d5dd`.

## Frozen integration and receipts

Frozen integration `a4509f143f99206576b113418c81e98e66eea9f5` and all other17 registered paths remain. The last side-notes removal verified its7fff3f9 head is an ancestor of that frozen commit; the earlier three were verified against6e49198, retained in the current ancestry. No build, app import, test, process signal or live-service action was performed during cleanup. Running full-suite processes41834/69881 were not touched.

- First three registered + two private copies: `final-owned-fixes-recovery/removal-results.json` and `final-owned-fixes-removal-final.log`.
- Last registered path: `final-side-notes-recovery-7fff3f9/removal-results.json` and `final-side-notes-removal.log`.
- Aggregate machine-readable mappings: `final-owned-fixes-cleanup-final.json`.

All receipt paths are under `/private/tmp/codeflow-qa-continue/`. Recovery folders contain file SHA256/mode/link manifests, HEAD/branch/status metadata, binary Git diffs and before/after registered inventories. Archives include ignored output and untracked content, omit only root `.git`/`node_modules`, and preserve symlinks without following them.
