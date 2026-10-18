import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { classifyGitFailure, describeGitFailure, git, gitAtLeast, gitError, withRepoLock, type GitFailure, type GitResult } from "./git.js";
import { createPullRequest } from "./github.js";
import { logWarn } from "./log.js";

/**
 * Getting a result out of code-flow: per-file diffs for review, merging a result branch into
 * one of your branches, opening a pull request, and cleaning up worktrees.
 */

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
  /** Unified diff for this file (without the `diff --git` header), possibly truncated. */
  patch: string;
  truncated: boolean;
}

const MAX_PATCH = 200_000;

/** Changes on `branch` since `base`, split per file. */
export async function branchDiff(repo: string, base: string, branch: string): Promise<DiffFile[]> {
  const range = `${base}..${branch}`;
  const numstat = await gitOrThrow(["diff", "--numstat", "-M", "-z", range], repo);
  const status = await gitOrThrow(["diff", "--name-status", "-M", "-z", range], repo);
  const patch = await gitOrThrow(["diff", "--no-color", "-M", range], repo);

  // --name-status -z: STATUS\0path\0 (renames: R100\0old\0new\0)
  const statusTokens = status.split("\0").filter((t) => t !== "");
  const kinds = new Map<string, { status: DiffFile["status"]; oldPath?: string }>();
  for (let i = 0; i < statusTokens.length; i++) {
    const code = statusTokens[i]![0];
    if (code === "R" || code === "C") {
      kinds.set(statusTokens[i + 2]!, { status: "renamed", oldPath: statusTokens[i + 1] });
      i += 2;
    } else {
      kinds.set(statusTokens[i + 1]!, { status: code === "A" ? "added" : code === "D" ? "deleted" : "modified" });
      i += 1;
    }
  }

  // --numstat -z: "add\tdel\tpath\0" or for renames "add\tdel\t\0old\0new\0"
  const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const numTokens = numstat.split("\0");
  for (let i = 0; i < numTokens.length; i++) {
    const token = numTokens[i]!;
    if (!token) continue;
    const [add = "", del = "", path = ""] = token.split("\t");
    let file = path;
    if (!file) {
      file = numTokens[i + 2] ?? "";
      i += 2;
    }
    counts.set(file, { additions: Number(add) || 0, deletions: Number(del) || 0, binary: add === "-" });
  }

  const patches = new Map<string, string>();
  for (const chunk of patch.split(/^diff --git /m).slice(1)) {
    const header = chunk.slice(0, chunk.indexOf("\n"));
    const target = header.match(/ b\/(.+)$/)?.[1];
    if (target) patches.set(target, chunk.slice(chunk.indexOf("\n") + 1));
  }

  return [...kinds.entries()].map(([path, kind]) => {
    const full = patches.get(path) ?? "";
    const count = counts.get(path) ?? { additions: 0, deletions: 0, binary: false };
    return {
      path,
      oldPath: kind.oldPath,
      status: kind.status,
      ...count,
      patch: full.length > MAX_PATCH ? full.slice(0, MAX_PATCH) : full,
      truncated: full.length > MAX_PATCH,
    };
  });
}

/** Where (if anywhere) `branch` is checked out among the repo's worktrees. */
async function checkedOutAt(repo: string, branch: string): Promise<string | undefined> {
  const out = await gitOrThrow(["worktree", "list", "--porcelain"], repo);
  let path: string | undefined;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return undefined;
}

export type MergeOutcome =
  | { ok: true; commit: string; method: "checkout" | "ref" }
  | { ok: false; conflicts: string[]; message: string };

/**
 * Merge `branch` into `into` without touching anything else:
 * - if `into` is checked out (e.g. your main checkout), merge there — only when it has no
 *   uncommitted changes, and put it back as it was if the merge fails;
 * - otherwise build the merge with `git merge-tree` and move the branch ref, so no checkout
 *   is needed at all.
 * Only a real conflict comes back as `ok: false` (an agent can resolve those); anything else
 * that stops the merge (untracked files in the way, a lock, a hook, no git identity) is an
 * error that says what to do.
 */
export async function mergeInto(repo: string, branch: string, into: string, message: string, expected?: { source: string; target: string; tree?: string }): Promise<MergeOutcome> {
  if ((await git(["show-ref", "--verify", "--quiet", `refs/heads/${into}`], repo)).code !== 0) {
    throw new Error(`Branch "${into}" doesn't exist`);
  }
  // Nothing else code-flow does may change worktrees or refs meanwhile (the lock isn't re-entrant).
  return withRepoLock(repo, async () => {
    if (expected) {
      const [source, target] = await Promise.all([gitOrThrow(["rev-parse", branch], repo), gitOrThrow(["rev-parse", `refs/heads/${into}`], repo)]);
      if (source.trim() !== expected.source || target.trim() !== expected.target) throw new Error("The result or merge target moved after validation. Validate the current merge target again.");
    }
    const checkout = await checkedOutAt(repo, into);
    return checkout ? mergeInCheckout(checkout, expected?.source ?? branch, into, message, expected) : mergeByRef(repo, expected?.source ?? branch, into, message, expected);
  });
}

async function mergeInCheckout(checkout: string, branch: string, into: string, message: string, expected?: { source: string; target: string; tree?: string }): Promise<MergeOutcome> {
  if (!existsSync(checkout)) throw new Error(`"${into}" is checked out at ${checkout}, which no longer exists`);
  // Changes to tracked files, staged or not. Untracked files only matter when the merge would
  // overwrite them, and git refuses that itself (told apart below).
  const status = await git(["status", "--porcelain", "--untracked-files=no"], checkout);
  if (status.code !== 0) throw new Error(`Couldn't read the state of ${checkout}: ${gitError(["status"], status)}`);
  if (status.stdout.trim()) {
    throw new Error(`"${into}" is checked out at ${checkout} and has uncommitted changes. Commit or stash them, then merge again.`);
  }
  if (await midMerge(checkout)) throw new Error(`${checkout} is in the middle of another merge. Finish it, or run \`git merge --abort\` there, then merge again.`);
  // With the index locked, git still starts the merge (and calls it a conflict) but can't undo
  // it either: don't start.
  const lockPath = (await git(["rev-parse", "--git-path", "index.lock"], checkout)).stdout.trim();
  const lock = lockPath && resolve(checkout, lockPath);
  if (lock && existsSync(lock)) throw new Error(`Couldn't merge into ${into}: ${describeGitFailure("locked")} (${lock})`);

  if (expected && (await gitOrThrow(["rev-parse", "HEAD"], checkout)).trim() !== expected.target) throw new Error("The checkout moved after merge validation; validate the current target again");
  let res = await git(["merge", "--no-ff", ...(expected?.tree ? ["--no-commit"] : []), "-m", message, branch], checkout);
  if (res.code === 0 && expected?.tree) {
    const tree = (await gitOrThrow(["write-tree"], checkout)).trim();
    if (tree !== expected.tree) {
      if (await midMerge(checkout)) {
        const abort = await git(["merge", "--abort"], checkout);
        if (abort.code) throw new Error("The merge tree differed from the verified tree and abort failed. Inspect the checkout before proceeding.");
      }
      throw new Error("The merge produced a different tree than validation. No merge was committed; validate the current result again.");
    }
    if (await midMerge(checkout)) res = await git(["commit", "-m", message], checkout);
  }
  if (res.code === 0) {
    const commit = (await gitOrThrow(["rev-parse", "HEAD"], checkout)).trim();
    if (expected?.tree && (await gitOrThrow(["rev-parse", `${commit}^{tree}`], checkout)).trim() !== expected.tree) {
      // A commit hook can rewrite the index. Undo only our own clean merge, retaining
      // any later user/hook changes instead of resetting an unrelated checkout state.
      const status = await git(["status", "--porcelain", "--untracked-files=no"], checkout);
      const stillOurCommit = (await gitOrThrow(["rev-parse", "HEAD"], checkout)).trim() === commit;
      const rollback = status.code === 0 && !status.stdout.trim() && stillOurCommit ? await git(["reset", "--merge", expected.target], checkout) : undefined;
      throw new Error(rollback?.code === 0 ? "A commit hook changed the verified merge tree. The merge was undone; review the hook and validate again." : "A commit hook changed the verified merge tree and the checkout changed afterwards. It was retained; inspect the checkout before proceeding.");
    }
    return { ok: true, commit, method: "checkout" };
  }
  let kind = mergeFailure(res);
  const conflicts = kind === "conflict" ? (await git(["diff", "--name-only", "--diff-filter=U"], checkout)).stdout.trim().split("\n").filter(Boolean) : [];
  // "Automatic merge failed" with nothing unmerged wasn't a conflict.
  if (kind === "conflict" && !conflicts.length) kind = "other";
  // A conflict, a failed hook or a missing identity can leave the merge half done: undo it, and
  // say so when that fails, rather than leave your checkout mid-merge without a word.
  if (await midMerge(checkout)) {
    const abort = await git(["merge", "--abort"], checkout);
    if (abort.code !== 0) {
      throw new Error(`Merging into ${into} failed (${describeGitFailure(kind)}), and undoing it failed too: ${gitError(["merge", "--abort"], abort)}. Run \`git merge --abort\` in ${checkout}.`);
    }
  }
  if (kind === "conflict") return { ok: false, conflicts, message: `Merging into ${into} would conflict` };
  throw new Error(`Couldn't merge into ${into} at ${checkout}: ${describeGitFailure(kind)}${details(kind, res)}`);
}

async function mergeByRef(repo: string, branch: string, into: string, message: string, expected?: { source: string; target: string; tree?: string }): Promise<MergeOutcome> {
  if (!(await gitAtLeast(2, 38))) {
    throw new Error(`Merging into "${into}" without checking it out needs git 2.38 or later. Check out ${into} somewhere and merge there, or upgrade git.`);
  }
  // Pin both parents before constructing their tree. Reading parents afterwards can
  // combine an old tree with a concurrently moved branch's new parent commits.
  const intoSha = (await gitOrThrow(["rev-parse", `refs/heads/${into}`], repo)).trim();
  const branchSha = (await gitOrThrow(["rev-parse", branch], repo)).trim();
  if (expected && (intoSha !== expected.target || branchSha !== expected.source)) throw new Error("The result or merge target moved after validation; validate again");
  const tree = await git(["merge-tree", "--write-tree", "--name-only", intoSha, branchSha], repo);
  if (tree.code === 1) {
    // Output: tree id, then the conflicted paths, then a blank line and messages.
    const lines = tree.stdout.split("\n");
    const conflicts = lines.slice(1, lines.indexOf("") === -1 ? undefined : lines.indexOf("")).filter(Boolean);
    return { ok: false, conflicts, message: `Merging into ${into} would conflict` };
  }
  if (tree.code !== 0) throw new Error(gitError(["merge-tree", "--write-tree", into, branch], tree));
  const treeId = tree.stdout.split("\n")[0]!.trim();
  if (expected?.tree && treeId !== expected.tree) throw new Error("The merge produced a different tree than validation. No branch was changed; validate again.");
  const commit = await git(["commit-tree", treeId, "-p", intoSha, "-p", branchSha, "-m", message], repo);
  if (commit.code !== 0) throw new Error(`Couldn't make the merge commit: ${describeGitFailure(classifyGitFailure(commit))}${details("other", commit)}`);
  // Moves the branch only if it's still where the merge started from.
  const update = await git(["update-ref", `refs/heads/${into}`, commit.stdout.trim(), intoSha], repo);
  if (update.code !== 0) {
    const kind = classifyGitFailure(update);
    throw new Error(kind === "locked" ? `Couldn't move ${into}: ${describeGitFailure(kind)}` : `${into} moved while merging, or couldn't be updated; merge again. ${gitError(["update-ref"], update)}`);
  }
  return { ok: true, commit: commit.stdout.trim(), method: "ref" };
}

/** True while a merge in `checkout` is started but not committed. */
async function midMerge(checkout: string): Promise<boolean> {
  return (await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], checkout)).code === 0;
}

function mergeFailure(res: GitResult): GitFailure {
  const text = `${res.stderr}\n${res.stdout}`;
  // A lock taken after the check above: git says it can't write the index, then "conflict".
  if (/Unable to write (?:new )?index/i.test(text)) return "locked";
  const kind = classifyGitFailure(res);
  // A pre-merge-commit or commit-msg hook says nothing git can recognise, but git then does.
  return kind === "other" && /Not committing merge/i.test(text) ? "hook" : kind;
}

/** The files git named (untracked files in the way…) or its last line, after a plain-language reason. */
function details(kind: GitFailure, res: GitResult): string {
  const text = `${res.stderr}\n${res.stdout}`;
  const files = text.split("\n").filter((l) => /^\t\S/.test(l)).map((l) => l.trim());
  if ((kind === "untracked" || kind === "dirty") && files.length) return `: ${files.slice(0, 10).join(", ")}${files.length > 10 ? ` and ${files.length - 10} more` : ""}. Move or commit them, then merge again.`;
  const last = text.split("\n").map((l) => l.trim()).filter(Boolean).pop();
  return last ? ` (git: ${last.slice(0, 300)})` : "";
}

/**
 * The branches on origin right now, and its default branch. Asks the remote itself: a local
 * origin/* ref outlives a branch deleted on GitHub (after its pull request was merged).
 */
export async function remoteBranches(repo: string): Promise<{ branches: string[]; defaultBranch?: string }> {
  const remote = await git(["remote", "get-url", "origin"], repo);
  if (remote.code !== 0) throw new Error("This repository has no 'origin' remote to open a pull request on");
  const out = await gitOrThrow(["ls-remote", "--symref", "origin", "HEAD", "refs/heads/*"], repo);
  const branches: string[] = [];
  let defaultBranch: string | undefined;
  for (const line of out.split("\n")) {
    const [left = "", ref = ""] = line.split("\t");
    if (left.startsWith("ref: refs/heads/") && ref === "HEAD") defaultBranch = left.slice("ref: refs/heads/".length);
    else if (ref.startsWith("refs/heads/")) branches.push(ref.slice("refs/heads/".length));
  }
  return { branches, defaultBranch };
}

/**
 * Where a result's pull request goes: the branch the run started from while it's still on
 * origin, otherwise origin's default branch (the starting branch was merged and deleted, or
 * never pushed).
 */
export async function pullRequestTarget(repo: string, startedFrom: string | undefined): Promise<string> {
  const { branches, defaultBranch } = await remoteBranches(repo);
  if (startedFrom && branches.includes(startedFrom)) return startedFrom;
  if (defaultBranch) return defaultBranch;
  throw new Error("Pick a branch to open the pull request into");
}

/**
 * Push the result branch and open a pull request with `gh`. `base` is the commit the run
 * started from: when it was squash-merged into `into` since, `into` is merged into the result
 * branch first, so the pull request shows only the run's own changes.
 */
export async function openPullRequest(
  repo: string,
  branch: string,
  into: string,
  title: string,
  body: string,
  base?: string,
): Promise<{ url: string; caughtUp?: string; note?: string }> {
  const { branches, defaultBranch } = await remoteBranches(repo);
  if (!branches.includes(into)) {
    const instead = defaultBranch && defaultBranch !== into ? `, such as ${defaultBranch}` : "";
    throw new Error(`"${into}" isn't a branch on GitHub (it may have been merged and deleted), so a pull request can't go into it. Pick another branch${instead}.`);
  }
  const caught = base ? await catchUpWithSquashedBase(repo, branch, into, base) : {};
  const push = await git(["push", "-u", "origin", branch], repo);
  if (push.code !== 0) {
    const kind = classifyGitFailure(push);
    throw new Error(`Pushing ${branch} failed: ${kind === "other" ? push.stderr.trim().split("\n").slice(-2).join(" ") : describeGitFailure(kind)}`);
  }
  // Pushed: from here a failure leaves a branch on GitHub, so a PR that's already open for it
  // (made by this attempt or an earlier one) is found and recorded rather than lost.
  const url = await createPullRequest(repo, { base: into, head: branch, title, body });
  return { url, caughtUp: caught.commit, note: caught.note };
}

/**
 * A run that started from a branch since squash-merged into `into` still carries that branch's
 * commits, and GitHub would show their changes again as part of the pull request. When `base`
 * adds nothing that origin's `into` doesn't already have, merge `into` into the result branch
 * (the files don't change) so the pull request shows only the run's commits. Returns the merge
 * commit, or nothing when nothing needed doing; `note` says why it couldn't tell.
 */
async function catchUpWithSquashedBase(repo: string, branch: string, into: string, base: string): Promise<{ commit?: string; note?: string }> {
  const target = `refs/remotes/origin/${into}`;
  await gitOrThrow(["fetch", "--quiet", "origin", `+refs/heads/${into}:${target}`], repo);
  if ((await git(["merge-base", "--is-ancestor", base, target], repo)).code === 0) return {};
  // Without merge-tree --write-tree, git says "usage", which mustn't read as "the base has changes".
  const cantTell = (why: string) => {
    const note = `Couldn't check whether the run's starting point was already squash-merged into ${into} (${why}); the pull request may show those changes again`;
    logWarn(note, { repo, branch });
    return { note };
  };
  if (!(await gitAtLeast(2, 38))) return cantTell("that needs git 2.38 or later");
  const merged = await git(["merge-tree", "--write-tree", target, base], repo);
  if (merged.code === 1) return {}; // base conflicts with `into`: its changes belong in the pull request
  if (merged.code !== 0) return cantTell(gitError(["merge-tree"], merged));
  const targetTree = (await gitOrThrow(["rev-parse", `${target}^{tree}`], repo)).trim();
  if (merged.stdout.split("\n")[0]!.trim() !== targetTree) return {}; // base has changes `into` doesn't
  const outcome = await mergeInto(repo, target, branch, `Merge origin/${into} into ${branch}`);
  if (!outcome.ok) {
    throw new Error(`origin/${into} conflicts with ${branch} in ${outcome.conflicts.join(", ")}. Merge it into the branch and resolve them, then open the pull request again.`);
  }
  return { commit: outcome.commit };
}

/**
 * Remove a run's worktrees (branches are kept unless asked). Returns what was removed, and
 * what couldn't be (with git's reason) instead of quietly leaving it behind.
 */
export async function removeWorktrees(
  repo: string,
  worktrees: { path: string; branch: string }[],
  deleteBranches: boolean,
): Promise<{ removed: string[]; deletedBranches: string[]; failed: string[] }> {
  return withRepoLock(repo, async () => {
    const removed: string[] = [];
    const deletedBranches: string[] = [];
    const failed: string[] = [];
    for (const wt of worktrees) {
      if (existsSync(wt.path)) {
        let res = await git(["worktree", "remove", "--force", wt.path], repo);
        // A worktree with submodules, or a locked one, takes --force twice.
        if (res.code !== 0) res = await git(["worktree", "remove", "--force", "--force", wt.path], repo);
        if (res.code === 0) removed.push(wt.path);
        else failed.push(`${wt.path}: ${shortError(res)}`);
      }
      if (deleteBranches && (await git(["show-ref", "--verify", "--quiet", `refs/heads/${wt.branch}`], repo)).code === 0) {
        const res = await git(["branch", "-D", wt.branch], repo);
        if (res.code === 0) deletedBranches.push(wt.branch);
        else failed.push(`branch ${wt.branch}: ${shortError(res)}`);
      }
    }
    await git(["worktree", "prune"], repo);
    if (failed.length) logWarn(`Couldn't remove everything in ${repo}`, { failed });
    return { removed, deletedBranches, failed };
  });
}

function shortError(res: GitResult): string {
  const kind = classifyGitFailure(res);
  const last = (res.stderr.trim() || res.stdout.trim()).split("\n").pop()?.trim() ?? "";
  return kind === "other" ? last.replace(/^(fatal|error):\s*/, "") || "git failed" : describeGitFailure(kind);
}

async function gitOrThrow(args: string[], cwd: string): Promise<string> {
  const res = await git(args, cwd);
  if (res.code !== 0) throw new Error(`git ${args[0]} failed: ${res.stderr.trim() || res.stdout.trim()}`);
  return res.stdout;
}

/** Disk space each folder takes, in bytes (folders that don't exist are left out). */
export async function folderSizes(paths: string[], timeoutMs = 30_000): Promise<Record<string, number>> {
  const existing = paths.filter((p) => existsSync(p));
  const sizes: Record<string, number> = {};
  for (let i = 0; i < existing.length; i += 50) {
    const batch = existing.slice(i, i + 50);
    const out = await new Promise<string>((resolve) => {
      // du exits non-zero when one file can't be read; what it printed is still right.
      execFile("du", ["-sk", ...batch], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (_err, stdout) => resolve(stdout?.toString() ?? ""));
    });
    for (const line of out.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab > 0) sizes[line.slice(tab + 1)] = Number(line.slice(0, tab)) * 1024;
    }
  }
  return sizes;
}
