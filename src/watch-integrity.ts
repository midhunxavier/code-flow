import { git, isAncestor, resolveCommit } from "./git.js";
import { inspectChanges, unverifiedIssue, type IntegrityIssue } from "./integrity.js";

/** Inspect everything an unattended push would publish, including earlier blocked turns. */
export async function unpublishedWatchIssues(repo: string, branch: string, remoteBranch: string, check?: string, counts?: { first: { head: string; tests: number }; last: { head: string; tests: number } }): Promise<IntegrityIssue[]> {
  try {
    if ((await git(["check-ref-format", `refs/heads/${remoteBranch}`], repo)).code) throw new Error("Invalid PR branch");
    const remote = await git(["ls-remote", "--exit-code", "origin", `refs/heads/${remoteBranch}`], repo);
    const head = remote.stdout.trim().match(/^([a-f0-9]{40,64})\s+refs\/heads\/[^\n]+$/)?.[1];
    if (remote.code || !head) throw new Error("Couldn't resolve the current PR branch on origin");
    try { await resolveCommit(repo, head); }
    catch {
      const fetched = await git(["fetch", "--no-tags", "origin", `refs/heads/${remoteBranch}`], repo);
      if (fetched.code) throw new Error("Couldn't fetch the current PR branch");
    }
    const local = await resolveCommit(repo, `refs/heads/${branch}`);
    if (head === local) return [];
    if (!await isAncestor(repo, head, local)) throw new Error("The PR has commits code-flow doesn't have");
    return await inspectChanges(repo, head, local, { check, tests: counts?.last.head === local ? { before: counts.first.tests, after: counts.last.tests } : undefined });
  } catch (error) { return [unverifiedIssue((error as Error).message)]; }
}
