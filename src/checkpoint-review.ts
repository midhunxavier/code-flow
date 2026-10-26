import { createHash } from "node:crypto";
import { assertWorktree, git, resolveCommit, withRepoLock, type GitCwd } from "./git.js";
import { inTemporaryWorktree } from "./readiness.js";
import { VerificationIntegrityError, verificationIntegrity } from "./verification-integrity.js";
import { CHECKPOINT_HEAD_MOVED, WorkspaceConflictError } from "./workspace.js";

const MAX_PATCH = 2 * 1024 * 1024;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function successful(args: string[], repo: GitCwd, signal?: AbortSignal) {
  const result = await git(args, repo, { signal, timeoutMs: 30_000 });
  if (result.code || result.aborted || result.timedOut) throw new Error(result.stderr.trim().slice(-2000) || "Could not inspect this checkpoint");
  return result.stdout;
}

async function hiddenTrackedFiles(repo: GitCwd, signal?: AbortSignal) {
  const flags = await git(["ls-files", "-v", "-z"], repo, { signal, timeoutMs: 10_000 });
  return flags.stdout.split("\0").some((file) => /^[a-zS] /.test(file));
}

export async function compareCheckpoint(repo: GitCwd, input: { from: string; to: string }, signal?: AbortSignal) {
  const [from, to] = await Promise.all([resolveCommit(repo, input.from), resolveCommit(repo, input.to)]);
  const [stat, patch, records] = await Promise.all([
    successful(["diff", "--no-ext-diff", "--no-textconv", "--stat", from, to, "--"], repo, signal),
    successful(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--submodule=short", from, to, "--"], repo, signal),
    successful(["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "--no-renames", from, to, "--"], repo, signal),
  ]);
  const fields = records.split("\0").filter(Boolean), files: { status: string; path: string }[] = [];
  for (let index = 0; index + 1 < fields.length && files.length < 1000; index += 2) files.push({ status: fields[index]!, path: fields[index + 1]! });
  return { from, to, stat: stat.slice(0, 64_000), patch: patch.slice(0, MAX_PATCH), files, truncated: patch.length > MAX_PATCH || fields.length > 2000 || stat.length > 64_000 };
}

export interface RevertPreview { head: string; commit: string; candidateTree: string; subject: string; patch: string; stat: string; fingerprint: string; staged: true }
/** Compute the inverse commit on a disposable checkout; conflicts never touch the user's files. */
export async function previewCommitRevert(repo: GitCwd, input: { commit: string; expectedHead: string }, signal?: AbortSignal, ownerRepo?: string): Promise<RevertPreview> {
  if (typeof repo !== "string" && !ownerRepo) throw new Error("Owned worktree previews require their original source repository");
  const [head, commit] = await Promise.all([resolveCommit(repo), resolveCommit(repo, input.commit)]);
  if (head !== input.expectedHead) throw new WorkspaceConflictError(head, CHECKPOINT_HEAD_MOVED);
  const ancestry = await git(["merge-base", "--is-ancestor", commit, head], repo, { signal });
  if (ancestry.code) throw new Error("Choose a commit in this worktree's history to revert");
  const parents = (await successful(["rev-list", "--parents", "-n", "1", commit], repo, signal)).trim().split(/\s+/);
  if (parents.length > 2) throw new Error("Merge commits require an explicit mainline decision; revert them with Git after reviewing both parents");
  const subject = (await successful(["show", "--no-patch", "--format=%s", commit], repo, signal)).trim().slice(0, 1000);
  const origin = ownerRepo ?? repo as string;
  return inTemporaryWorktree(origin, head, async (path) => {
    const at = await assertWorktree(origin, { path });
    const reverted = await git(["-c", "core.hooksPath=/dev/null", "revert", "--no-commit", commit], at, { signal, timeoutMs: 30_000 });
    if (reverted.code || reverted.aborted || reverted.timedOut) throw new Error(`This revert needs conflict resolution. The original worktree is unchanged. ${reverted.stderr.trim().slice(-1500)}`);
    const [candidateTree, patch, stat] = await Promise.all([
      successful(["write-tree"], at, signal).then((text) => text.trim()),
      successful(["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", head, "--"], at, signal),
      successful(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--stat", head, "--"], at, signal),
    ]);
    if (!patch) throw new Error("This commit has no remaining change to revert at the selected HEAD");
    if (Buffer.byteLength(patch) > MAX_PATCH) throw new Error("This revert exceeds the 2 MiB review limit; use Git to review and revert it");
    const value = { head, commit, candidateTree, subject, patch, stat, staged: true as const };
    return { ...value, fingerprint: digest(value) };
  }, signal);
}

/** Caller holds the manager's idle-workspace lease. Caller-supplied patches are never accepted. */
export async function applyCommitRevert(repo: GitCwd, input: { commit: string; expectedHead: string; fingerprint: string }, signal?: AbortSignal, ownerRepo?: string) {
  // Temporary-worktree creation also takes Git's repository lock; prepare before taking it.
  const preview = await previewCommitRevert(repo, input, signal, ownerRepo);
  return withRepoLock(typeof repo === "string" ? repo : repo.path, () => applyReviewedRevert(repo, input, preview, signal));
}
async function applyReviewedRevert(repo: GitCwd, input: { commit: string; expectedHead: string; fingerprint: string }, preview: RevertPreview, signal?: AbortSignal) {
  if (typeof input.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.fingerprint)) throw new Error("Preview this revert before applying it");
  // Ordinary changes first, so they get this message rather than the integrity check's verification wording.
  const status = await successful(["status", "--porcelain", "--untracked-files=all"], repo, signal);
  if (status.trim()) throw new Error("Commit or save all existing changes before reverting a commit");
  const integrity = await verificationIntegrity(repo, signal).catch(async (error) => { throw error instanceof VerificationIntegrityError ? new Error(await hiddenTrackedFiles(repo, signal) ? "Git flags hid tracked files from comparison (assume-unchanged or skip-worktree). Clear them before reverting a commit." : "The worktree changed while the revert was being checked; nothing was applied. Preview the inverse commit again.") : error; });
  const current = await resolveCommit(repo);
  if (current !== preview.head) throw new WorkspaceConflictError(current, CHECKPOINT_HEAD_MOVED);
  if (preview.fingerprint !== input.fingerprint) throw new WorkspaceConflictError(current, "This revert changed since you previewed it. Preview the inverse commit again before staging it.");
  await integrity.assert("revert preview").catch((error) => { throw error instanceof VerificationIntegrityError ? new Error("The worktree changed while the revert was being checked; nothing was applied. Preview the inverse commit again.") : error; });
  const checked = await git(["apply", "--index", "--check", "--whitespace=nowarn", "-"], repo, { signal, input: preview.patch, timeoutMs: 30_000 });
  if (checked.code || checked.aborted || checked.timedOut) throw new Error(checked.stderr.trim() || "The reviewed revert no longer applies cleanly");
  // apply --index checks both the index and working files, and applies the patch atomically.
  const result = await git(["apply", "--index", "--whitespace=nowarn", "-"], repo, { signal, input: preview.patch, timeoutMs: 30_000 });
  if (result.code || result.aborted || result.timedOut) throw new Error(result.stderr.trim() || "The revert could not be applied; inspect the worktree before retrying");
  const [head, tree] = await Promise.all([resolveCommit(repo), successful(["write-tree"], repo, signal).then((text) => text.trim())]);
  if (head !== preview.head || tree !== preview.candidateTree) throw new WorkspaceConflictError(head, "The worktree changed while the revert was applied. Inspect it before retrying.");
  return { head, commit: preview.commit, tree, staged: true, note: "The inverse change is staged for review. Commit it to record the revert; existing history has not been rewritten." };
}
