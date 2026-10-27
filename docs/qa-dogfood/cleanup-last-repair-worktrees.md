# Final QA lane cleanup summary

The final seven approved manual QA checkouts were removed after verified full preservation. Added to the previously completed 94 removals reported by the parent task, the cumulative total is **101 removed QA worktrees**. This report independently verifies the seven final removals; it does not re-audit the earlier 94.

All seven branch refs still name their pinned commits. All seven archive digests were rechecked after removal. Integration and every unrelated registration remain. No force option or process termination was used.

| Removed checkout | Commit | Preserved branch |
|---|---|---|
| /private/tmp/codeflow-qa-final-suite-repairs | `5e4cf8849a714490f7c72cd0b5fe8cd29fbed5a6` | `refs/heads/codex/qa-final-unit-followup` |
| /private/tmp/codeflow-qa-final-memory-onboarding | `e57a7593baffcc6a74af489c7c548e3ec4c5e5d2` | `refs/heads/codex/qa-final-memory-onboarding` |
| /private/tmp/codeflow-qa-final-suite-followup | `bcecadc10dc8888f0ac7bcd1f9ae93e7113eab18` | `refs/heads/codex/qa-final-suite-followup` |
| /private/tmp/codeflow-qa-final-a11y-hang | `74f0c5d0ae7cd24e25dee6cd3dae0d6c3df6c070` | `refs/heads/codex/qa-final-a11y-hang` |
| /private/tmp/codeflow-qa-final-pending-routing | `f88b0f072bcf01db4de201a5588f58d605172e00` | `refs/heads/codex/qa-final-pending-routing` |
| /private/tmp/codeflow-qa-final-collab-followup | `0574e3f2a472efa4b55c1022f6b457aeaa2ad7b4` | `refs/heads/codex/qa-final-collab-followup` |
| /private/tmp/codeflow-qa-final-repo-defaults | `cda10e1ac42dbd5e6c5167fc0b5df6744f0ab425` | `refs/heads/codex/qa-final-repo-defaults` |

## Exact archives and checksums

- **codeflow-qa-final-suite-repairs**
  - Archive: `/private/tmp/codeflow-qa-continue/last-lane-preservation-20261026T175710Z-10d93765/codeflow-qa-final-suite-repairs.tar.gz`
  - SHA-256: `0e6bc1799d0de07aac9f7b68bce1b966788a94849a4255dd8d6591c78234c5f0`
  - Removal receipt: `/private/tmp/codeflow-qa-continue/last-lane-preservation-20261026T175710Z-10d93765/removal-six-20261026T180026Z-b4a080e1/codeflow-qa-final-suite-repairs.receipt.json`
- **codeflow-qa-final-memory-onboarding**
  - Archive: `/private/tmp/codeflow-qa-continue/last-lane-preservation-20261026T175710Z-10d93765/codeflow-qa-final-memory-onboarding.tar.gz`
  - SHA-256: `392147a0d16eda2ab19e2305187dd11182230857917f1ebc0ea509f340b340b4`
  - Removal receipt: `/private/tmp/codeflow-qa-continue/last-lane-preservation-20261026T175710Z-10d93765/removal-six-20261026T180026Z-b4a080e1/codeflow-qa-final-memory-onboarding.receipt.json`
- **codeflow-qa-final-suite-followup**
  - Archive: `/private/tmp/codeflow-qa-continue/last-lane-preservation-20261026T175710Z-10d93765/codeflow-qa-final-suite-followup.tar.gz`
  - SHA-256: `4f587b01f73352b1c0a1548339da48e7c6f672754c4053ce65ca4015e94bd911`
  - Removal receipt: `/private/tmp/codeflow-qa-continue/last-lane-preservation-20261026T175710Z-10d93765/removal-six-20261026T180026Z-b4a080e1/codeflow-qa-final-suite-followup.receipt.json`
- **codeflow-qa-final-a11y-hang**
  - Archive: `/private/tmp/codeflow-qa-continue/last-lane-preservation-20261026T175710Z-10d93765/codeflow-qa-final-a11y-hang.tar.gz`
  - SHA-256: `b0028f584d141b9d76a83067f67ca796e959ff4f7f7b3bee2079e566a1f12236`
  - Removal receipt: `/private/tmp/codeflow-qa-continue/last-lane-preservation-20261026T175710Z-10d93765/removal-six-20261026T180026Z-b4a080e1/codeflow-qa-final-a11y-hang.receipt.json`
- **codeflow-qa-final-pending-routing**
  - Archive: `/private/tmp/codeflow-qa-continue/last-lane-preservation-20261026T175710Z-10d93765/codeflow-qa-final-pending-routing.tar.gz`
  - SHA-256: `4023fb8f01d7c7dcebd7e32eca7faa858b5787923d6b47227bcdee3cf66270cf`
  - Removal receipt: `/private/tmp/codeflow-qa-continue/last-lane-preservation-20261026T175710Z-10d93765/removal-six-20261026T180026Z-b4a080e1/codeflow-qa-final-pending-routing.receipt.json`
- **codeflow-qa-final-collab-followup**
  - Archive: `/private/tmp/codeflow-qa-continue/last-lane-preservation-20261026T175710Z-10d93765/codeflow-qa-final-collab-followup.tar.gz`
  - SHA-256: `085b6070a83b056f6c4ce0d3a78265a6da02e4f155bd6048fbb3e2d9e7a72b25`
  - Removal receipt: `/private/tmp/codeflow-qa-continue/last-lane-preservation-20261026T175710Z-10d93765/removal-six-20261026T180026Z-b4a080e1/codeflow-qa-final-collab-followup.receipt.json`
- **codeflow-qa-final-repo-defaults**
  - Archive: `/private/tmp/codeflow-qa-continue/last-lane-preservation-seventh-20261026T180130Z-6efd1576/codeflow-qa-final-repo-defaults.tar.gz`
  - SHA-256: `033312a4b3978efe5b80db44ef331da0b672011af0c88875ec23023a2812364c`
  - Removal receipt: `/private/tmp/codeflow-qa-continue/last-lane-preservation-seventh-20261026T180130Z-6efd1576/removal-seventh-20261026T180331Z-117cf086/receipt.json`

## Evidence recovery

Old documentation links into a removed checkout no longer resolve directly. Each listed archive retains the complete checkout under `checkout/`, including ignored evidence and generated files; an old relative `output/...` link is now `checkout/output/...` inside that checkout’s archive. SHA/mode/link manifests identify each preserved entry. Git commit/branch/status and binary-diff metadata are under `git-metadata/`, with matching adjacent metadata files. `.git` and `node_modules` entries were deliberately excluded and enumerated; symlink targets were not followed. External evidence already under `/private/tmp/codeflow-qa-continue/` remains in place.

No integration source or documentation files were edited during preservation/removal; this central report is available for the parent task to copy after its frozen full-suite run.

## Final auth replay cleanup

The unchanged authentication replay used one additional checkout, `/private/tmp/codeflow-qa-final-auth-navigation`, at frozen `9e4a7f1`. Its complete archive was verified and the clean inactive checkout removed with ordinary Git removal; branch `codex/qa-final-auth-navigation` remains. Archive: `/private/tmp/codeflow-qa-continue/auth-navigation-recovery/checkout.tar.gz`, SHA256 `6955e56c2f52a56df63c94f50c382cf1c98f7d7b8e52048aa721e7620e6c3a4f`. The receipt is `auth-navigation-cleanup-results.json`; source and diagnostics remain under `auth-navigation-unchanged-evidence/`. This brings cumulative cleanup to102 QA worktrees.
