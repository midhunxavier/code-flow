# Recent final repair worktree cleanup

Completed only the three explicitly authorized registered worktree removals. Each was clean, had its expected branch and exact HEAD, and was an ancestor of integration `3a5e983c1ac31792887e22f3dbb1d541e95ed94a`. Integration HEAD and all other registry entries remained unchanged.

Before removal, each complete checkout was archived, including ignored files and outputs, excluding only root `.git` and `node_modules`. Symlinks were recorded without following them. Every archived file SHA-256, mode, and symlink target was verified against the manifest; the current checkout was compared again with that manifest immediately before removal. Archive and manifest hashes were rechecked. Exact-path process working directories, command lines, and open files were empty; no related listener was found. No process was stopped.

| Removed checkout | Retained branch | Exact HEAD |
| --- | --- | --- |
| `/private/tmp/codeflow-qa-final-integration-draft-race` | `codex/qa-final-integration-draft-race` | `8d1a99fe1aa689f0bc598495aa47016dcb1b3a91` |
| `/private/tmp/codeflow-qa-phone-auth-audit` | `codex/qa-phone-auth-audit` | `4d79e0900c0517a9bd2aa5fd8df40a18ccb7df3a` |
| `/private/tmp/codeflow-qa-final-preview-navigation` | `codex/qa-final-preview-navigation` | `e9a8b80f90a2d9d2329be4f9b088b02f9aedf3a4` |

Recovery archives and SHA-256:

- [codeflow-qa-final-integration-draft-race](/private/tmp/codeflow-qa-continue/final-recent-fixes-recovery/codeflow-qa-final-integration-draft-race/checkout.tar.gz)
  - Archive SHA-256: `3f1513f46a528ff03d94e1498f3580be1cf5b4fb60adeb8bad273724e63699f3`.
  - [Full manifest](/private/tmp/codeflow-qa-continue/final-recent-fixes-recovery/codeflow-qa-final-integration-draft-race/manifest.json): `21927ae501b92efa18aa6f3fe843ca0033c00fdbeda7ba1d712824462795b7e0`; 1502 entries.
- [codeflow-qa-phone-auth-audit](/private/tmp/codeflow-qa-continue/final-recent-fixes-recovery/codeflow-qa-phone-auth-audit/checkout.tar.gz)
  - Archive SHA-256: `9763cf788112f770c7edc5700881bd899db6696ba6bdba91f1ef1d23db2a763f`.
  - [Full manifest](/private/tmp/codeflow-qa-continue/final-recent-fixes-recovery/codeflow-qa-phone-auth-audit/manifest.json): `6cb5978c640d53a2d5ebd1529b688ed09e3e8453567b24586721f4ae90a36c8d`; 1468 entries.
- [codeflow-qa-final-preview-navigation](/private/tmp/codeflow-qa-continue/final-recent-fixes-recovery/codeflow-qa-final-preview-navigation/checkout.tar.gz)
  - Archive SHA-256: `f45b96111894e5105da6746a25520b1a4895204e1da811826dd299c840b21b96`.
  - [Full manifest](/private/tmp/codeflow-qa-continue/final-recent-fixes-recovery/codeflow-qa-final-preview-navigation/manifest.json): `cad22e8a36e99aebabc1262d1344e3841e1ba7a0555e73a99bb1b7be58f21f69`; 1509 entries.

Each branch remains at the recorded HEAD. To recover, create a new worktree from that retained branch and restore its archived checkout over it; the archive contains no Git registration or dependency directory.

Accounting: the prior total was **106** registered QA worktree removals. The parent separately reported removal of `/private/tmp/codeflow-qa-continue/work/phone-revocation`, bringing the total to **107**; this audit independently confirms that path is absent from the registry but did not perform or re-audit its removal. The three removals in this receipt bring the cumulative total to **110**. The registered worktree count changed **20 → 17**, with exactly these three paths removed and no other registry changes. No unregistered copies were removed in this action; the earlier two-copy accounting remains separate.

All removals used ordinary `git worktree remove` without force. Branches, recovery archives, integration, live checkouts, and all other registered paths were retained. No app import, build, test, browser, service, or live-port interaction was performed.

[Machine-readable receipt](/private/tmp/codeflow-qa-continue/final-recent-fixes-cleanup.json) includes all checks and per-check timestamps. Before/after registry snapshots and complete recovery metadata are under [the recovery directory](/private/tmp/codeflow-qa-continue/final-recent-fixes-recovery).
