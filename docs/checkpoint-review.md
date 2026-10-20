# Checkpoints and reversions

Open Project → Repository tools → History, compare the checkpoint, then preview the inverse commit. Apply only after inspecting the patch; the inverse change remains staged for your own commit.

## Review before reverting

Project → Repository tools → History compares the selected checkpoint with the observed HEAD across
all changed paths. The patch preview is bounded to 2 MiB; large comparisons are
explicitly marked truncated. Both comparison endpoints resolve to immutable commits.

For an owned idle run worktree, **Preview inverse commit** computes a normal Git
revert on a disposable checkout. Conflicting reversions do not change the user's
worktree. Merge commits require an explicit mainline decision in Git and are refused
by this interface. Commits outside the worktree's ancestry are also refused.

**Stage reviewed inverse change** recomputes the preview, verifies its fingerprint
and the observed HEAD, and applies the server-generated inverse patch to a clean
index and working copy. Tracked-file hiding flags are refused. An in-process workspace
lease prevents another Code Flow start, resume or mutation from racing the operation.
The change remains staged for review and a normal user commit; history is preserved.
Existing modifications, unknown files that would be overwritten and stale previews
prevent application. External programs are outside Code Flow's process coordination;
Git's index checks still guard the actual application.

The API operations are `POST /api/v1/workspace/compare-checkpoint`,
`/preview-revert` and `/apply-revert`. Comparison accepts `repo`, `from`, `to`.
Revert preview accepts `repo`, `runId`, `commit`, `expectedHead`; apply also requires
the returned `fingerprint`. Caller-authored patches are not accepted.

Validation covers complete comparison, staged inverse changes, history preservation,
conflicts, stale/forged previews, dirty worktrees, hidden tracked-file changes, and
the actual browser preview/application flow.

---

[Documentation library](README.md) · [Getting started](getting-started.md) · [Ask code-flow](help.md)
