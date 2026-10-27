# Historical QA local-change cleanup

Removed **11** inactive historical QA worktrees from the explicit `/private/tmp` inventory, after verified recovery snapshots. No branch was deleted and no process was terminated. Every current final lane, real-alias-verification path and integration checkout remained registered.

Archives total **167,674,843 bytes** (13,979 entries including metadata). Stored in `/private/tmp/codeflow-qa-continue/cleanup-local-changes-recovery/`.

Each archive contains the whole checkout, including source, untracked files, ignored output and evidence. The only omitted path components are `.git` and `node_modules`. Symlinks are retained as symlinks and never followed. Every archived file was checked against its SHA-256 and byte count; file types, modes, directory membership and symlink targets were checked too. Source manifests and Git state were compared again before removal. Process-CWD checks ran before archiving and immediately before removal; none of the eligible checkouts was active.

Recovery metadata includes HEAD, symbolic branch or detached status, full Git status, NUL-safe status bytes, binary HEAD/staged/worktree diffs, and a full checkout manifest. Each HEAD is pinned by a verified `refs/codeflow/qa-cleanup/...` reference, and existing branches remain. `codex/qa-team-dialogs-templates` still names `32983025aebe1226cfeba7db9c62b7b0c5da3c27`. Archives and recovery refs were independently rechecked after removal.

| Removed checkout | Archive | HEAD | Recovery ref |
| --- | --- | --- | --- |
| `/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/fixes-scratch/merge-ship-conflicts/base-wt` | `base-wt-e4cdb323df6c.tar.gz` | `5cf4ed04b5640df7cdaf84c4bdc12c379d2448a4` | `refs/codeflow/qa-cleanup/e4cdb323df6c` |
| `/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/collab-attempts/base` | `base-786d18919931.tar.gz` | `5cf4ed04b5640df7cdaf84c4bdc12c379d2448a4` | `refs/codeflow/qa-cleanup/786d18919931` |
| `/private/tmp/codeflow-qa-clients-baseline` | `codeflow-qa-clients-baseline-8b0790a9c0be.tar.gz` | `173ce2881dcfda1fee95543253d51a9f422cc84c` | `refs/codeflow/qa-cleanup/8b0790a9c0be` |
| `/private/tmp/codeflow-qa-continue/coordinated-baseline` | `coordinated-baseline-845c01fa59f3.tar.gz` | `fbc956216a3d55cc8903890f6b3f10c460d69b9a` | `refs/codeflow/qa-cleanup/845c01fa59f3` |
| `/private/tmp/codeflow-qa-continue/team-dialogs-templates` | `team-dialogs-templates-80282209eef6.tar.gz` | `32983025aebe1226cfeba7db9c62b7b0c5da3c27` | `refs/codeflow/qa-cleanup/80282209eef6` |
| `/private/tmp/codeflow-qa-continue/verify-step1` | `verify-step1-336be3a7a946.tar.gz` | `bc60775ef0393afb9103918b9f0bfe8d6c11f2a5` | `refs/codeflow/qa-cleanup/336be3a7a946` |
| `/private/tmp/codeflow-qa-health-baseline` | `codeflow-qa-health-baseline-89bde3e9c6ff.tar.gz` | `9660b0ad4168efc2bed853288f455c550e466c57` | `refs/codeflow/qa-cleanup/89bde3e9c6ff` |
| `/private/tmp/codeflow-qa-history-review` | `codeflow-qa-history-review-4a5b0b90c62f.tar.gz` | `ddc6a1d3f884173ca9782694a1e9de376b7e827d` | `refs/codeflow/qa-cleanup/4a5b0b90c62f` |
| `/private/tmp/codeflow-qa-memory-ml-baseline` | `codeflow-qa-memory-ml-baseline-58db724cb22c.tar.gz` | `385a19ea416f4841404371f366b6823c3a6b6ac4` | `refs/codeflow/qa-cleanup/58db724cb22c` |
| `/private/tmp/codeflow-qa-preview-baseline` | `codeflow-qa-preview-baseline-437edb8d4df8.tar.gz` | `bd09dc5239455670a8f035570bd0746061d54c76` | `refs/codeflow/qa-cleanup/437edb8d4df8` |
| `/private/tmp/codeflow-qa-stream-baseline` | `codeflow-qa-stream-baseline-deef26d0ac74.tar.gz` | `d9050230e5f2b275e475dc79c088ed1c14e9c319` | `refs/codeflow/qa-cleanup/deef26d0ac74` |

The report JSON is `cleanup-local-changes-results.json`; it records each archive SHA-256, exact status, branch, exclusions, entry count, archive path and removal result. `cleanup-local-worktrees-before.txt` and `cleanup-local-worktrees-after.txt` prove that precisely these 11 paths were removed. The final daily worktree listed as dirty in the original plan was explicitly excluded. Other current lanes were excluded from selection altogether.

To recover a checkout, first create a new detached worktree at its recorded recovery ref in a chosen fresh location. Extract the archive into a separate recovery directory and overlay the preserved `checkout/` files into that worktree. The `git-metadata/` binary patches preserve staged versus unstaged changes if that distinction is needed; untracked and ignored files are already present in the full snapshot. The private recovery refs retain commit history without depending on temporary worktree metadata. Do not delete the archives or recovery refs until the preserved work is no longer needed.
