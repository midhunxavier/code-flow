import { basename } from "node:path";
import { assertWorktree, branchExists, git, resolveCommit } from "./git.js";
import { inTemporaryWorktree } from "./readiness.js";
import { runCheck, type Container } from "./checks.js";
import { runVerification, type VerificationProfile, type VerificationReport } from "./verification.js";
import { readOnlyGitMetadata } from "./agent-container.js";

export interface MergeValidation { branch: string; into: string; source: string; target: string; tree?: string; report?: VerificationReport; conflicts: string[]; at: number }

/** Verify the actual merge result on a disposable checkout, leaving both branches untouched. */
export async function validateMergeTarget(repo: string, input: { branch: string; into: string; targetCommit?: string; profile: VerificationProfile; setup?: string; container?: Container; signal?: AbortSignal }): Promise<MergeValidation> {
  const localCommit = async (branch: string, target: boolean) => {
    if (!branch.trim()) throw new Error(target ? "Choose a target branch" : "Choose a result branch");
    if ((await git(["check-ref-format", "--branch", branch], repo)).code) throw new Error(`Choose a valid local ${target ? "target" : "result"} branch`);
    if (!await branchExists(repo, branch)) throw new Error(`Branch "${branch}" does not exist in ${basename(repo)}. Choose an existing local branch.`);
    return resolveCommit(repo, `refs/heads/${branch}`);
  };
  const [source, target] = await Promise.all([localCommit(input.branch, false), input.targetCommit ? resolveCommit(repo, input.targetCommit) : localCommit(input.into, true)]);
  return inTemporaryWorktree(repo, target, async (path) => {
    const checkout = await assertWorktree(repo, { path });
    const container = input.container ? { ...input.container, readOnly: [...new Set([...(input.container.readOnly ?? []), ...readOnlyGitMetadata(path)])] } : undefined;
    const merged = await git(["-c", "core.hooksPath=/dev/null", "-c", "user.name=code-flow validation", "-c", "user.email=validation@code-flow.invalid", "merge", "--no-commit", "--no-ff", source], checkout, { signal: input.signal });
    const result: MergeValidation = { branch: input.branch, into: input.into, source, target, conflicts: [], at: Date.now() };
    if (merged.code) {
      result.conflicts = (await git(["diff", "--name-only", "--diff-filter=U", "-z"], checkout)).stdout.split("\0").filter(Boolean);
      if (!result.conflicts.length) throw new Error(merged.stderr.trim() || merged.stdout.trim() || "Cannot construct the merge target");
      return result;
    }
    const tree = await git(["write-tree"], checkout);
    if (tree.code) throw new Error(tree.stderr.trim() || "Cannot record the merge tree");
    result.tree = tree.stdout.trim();
    // A successful command must describe this exact candidate, not a checkout a setup or
    // previous gate rewrote. Generated/untracked files are permitted; tracked text, the
    // staged tree and HEAD must remain the merged candidate throughout verification.
    const assertCandidate = async (stage: string) => {
      if (input.signal?.aborted) throw new Error("Merge validation was cancelled");
      await assertWorktree(repo, { path });
      const options = { signal: input.signal, timeoutMs: 10_000 };
      const [currentHead, currentTree, unstaged, flags] = await Promise.all([
        git(["rev-parse", "--verify", "HEAD^{commit}"], checkout, options),
        git(["write-tree"], checkout, options),
        git(["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--quiet", "--exit-code", "--"], checkout, options),
        git(["ls-files", "-v", "-z"], checkout, options),
      ]);
      if (input.signal?.aborted) throw new Error("Merge validation was cancelled");
      const hidden = flags.stdout.split("\0").some((file) => /^[a-zS] /.test(file));
      if (currentHead.code || currentTree.code || unstaged.code || flags.code || hidden || currentHead.stdout.trim() !== target || currentTree.stdout.trim() !== result.tree) throw new Error(`Merge validation ${stage} changed tracked files, the staged tree or the checkout commit, or hid tracked files from comparison. The original merge candidate was not verified.`);
    };
    await assertCandidate("merge construction");
    if (input.setup) {
      await assertCandidate("before setup");
      const setup = await runCheck(path, input.setup, { signal: input.signal, container, timeoutMs: 120000 });
      await assertCandidate("setup");
      if (!setup.ok) throw new Error(`Merge validation setup failed: ${setup.output.slice(-2000)}`);
    }
    result.report = await runVerification(path, input.profile, {
      signal: input.signal, container,
      execute: async (check, options) => {
        await assertCandidate(`before gate ${check.id}`);
        const checked = await runCheck(path, check.command, options);
        await assertCandidate(`gate ${check.id}`);
        return checked;
      },
    });
    await assertCandidate("completion");
    return result;
  }, input.signal);
}
