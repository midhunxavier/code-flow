# Authorized final QA worktree removal

Removed **9 exact approved worktrees**; **0 skipped**. Every checkout passed its current HEAD/status and process-CWD checks immediately before removal. No process was terminated, no branch was deleted, no private recovery ref was deleted, and all preserved archives retained their SHA-256 values.

| Removed checkout | Preserved HEAD | Recovery |
| --- | --- | --- |
| `/private/tmp/codeflow-final-partials-git-remote` | `261f9f34f7f4c8ad0b4b72112aea20353bd952e5` | Committed ancestor of frozen `cd93ad1`; canonical evidence retained |
| `/private/tmp/codeflow-final-security-review` | `6eb901c9b7dd5ae061197df7016f5d51e39b74d8` | Committed ancestor of frozen `cd93ad1`; canonical evidence retained |
| `/private/tmp/codeflow-qa-final-agy-denial` | `4b6a9a8757d63f8ba5307c7532badfda6c3f75fe` | Committed ancestor of frozen `cd93ad1`; canonical evidence retained |
| `/private/tmp/codeflow-qa-final-approval-attention` | `15a70ad7835b88fa379bb67f184def687eef3615` | Verified output archive |
| `/private/tmp/codeflow-qa-final-partials-daily` | `3664d56f828e8a9f7c130b0f463405a90ab1b50c` | Verified output archive |
| `/private/tmp/codeflow-qa-final-partials-team-ml` | `0522e43af0138f7a9c5717e68f874a3245cc1bd7` | Committed ancestor of frozen `cd93ad1`; canonical evidence retained |
| `/private/tmp/codeflow-qa-final-shell-phone-repairs` | `f76f9e3b734ba403d4de9fb417c30a4a187a0d74` | Verified output archive |
| `/private/tmp/codeflow-qa-real-alias-verification` | `7b5dffbf8bca9f8e829a5111d21326b1f4d6b5cf` | Committed ancestor of frozen `cd93ad1`; canonical evidence retained |
| `/private/tmp/codeflow-final-delta-review` | `61c652388f719213d8ec34162c672ac61d7ad0bd` | Archive `/private/tmp/codeflow-qa-continue/final-lane-preservation/codeflow-final-delta-review-fa148470943a.tar.gz`; ref `refs/codeflow/qa-final-preserve/fa148470943a` |

Kept explicitly:

- `/Users/mx/.codex/worktrees/dogfood-qa-continue/code-flow`
- `/private/tmp/codeflow-qa-final-memory-onboarding`
- `/private/tmp/codeflow-qa-final-suite-followup`
- `/private/tmp/codeflow-qa-final-suite-repairs`

The delta checkout contained exactly the two previously preserved untracked probe files. Its full archive, file manifest, binary diffs, status and private HEAD ref were verified again before its explicitly authorized force removal. The other eight removals used ordinary `git worktree remove` after clean-state and frozen-base ancestry checks. No removal command used a path glob.

Before/after registration inventories are `final-approved-worktrees-before.txt` and `final-approved-worktrees-after.txt`. Their path difference is exactly the nine removed paths; no new registration appeared during the operation. `final-approved-branches-before.json` records each removed checkout’s named branch; each still resolves to the same commit. Detached delta history remains pinned by `refs/codeflow/qa-final-preserve/fa148470943a`.

Exact operation records: `final-approved-removal-results.json`, `final-approved-removal-summary.json`, `final-approved-remove.log`. Recovery archives and SHA/manifests/path mappings: `final-lane-preservation/`, `final-lane-preservation-results.json`, `final-worktree-preservation-proposal.md`. Old lane-output filesystem paths are now represented by those archives; their `git-metadata/git-state.json` maps original payload paths to archive `checkout/`. Extract into a fresh recovery directory if the raw files are needed.

The live checkout/listeners, user repositories, user application home, integration files and all unrelated checkouts were untouched. The evidence root `/private/tmp/codeflow-qa-continue` remains protected.
