import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { git } from "./git.js";

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
 *   uncommitted changes, and abort cleanly on conflicts;
 * - otherwise build the merge with `git merge-tree` and move the branch ref, so no checkout
 *   is needed at all.
 */
export async function mergeInto(repo: string, branch: string, into: string, message: string): Promise<MergeOutcome> {
  if ((await git(["show-ref", "--verify", "--quiet", `refs/heads/${into}`], repo)).code !== 0) {
    throw new Error(`Branch "${into}" doesn't exist`);
  }
  const checkout = await checkedOutAt(repo, into);
  if (checkout) {
    if (!existsSync(checkout)) throw new Error(`"${into}" is checked out at ${checkout}, which no longer exists`);
    const dirty = (await git(["diff", "--quiet", "HEAD"], checkout)).code !== 0;
    if (dirty) {
      throw new Error(`"${into}" is checked out at ${checkout} and has uncommitted changes. Commit or stash them, then merge again.`);
    }
    const res = await git(["merge", "--no-ff", "-m", message, branch], checkout);
    if (res.code === 0) return { ok: true, commit: (await gitOrThrow(["rev-parse", "HEAD"], checkout)).trim(), method: "checkout" };
    const conflicts = (await git(["diff", "--name-only", "--diff-filter=U"], checkout)).stdout.trim().split("\n").filter(Boolean);
    await git(["merge", "--abort"], checkout);
    return { ok: false, conflicts, message: `Merging into ${into} would conflict` };
  }

  const tree = await git(["merge-tree", "--write-tree", "--name-only", into, branch], repo);
  if (tree.code === 1) {
    // Output: tree id, then the conflicted paths, then a blank line and messages.
    const lines = tree.stdout.split("\n");
    const conflicts = lines.slice(1, lines.indexOf("") === -1 ? undefined : lines.indexOf("")).filter(Boolean);
    return { ok: false, conflicts, message: `Merging into ${into} would conflict` };
  }
  if (tree.code !== 0) throw new Error(`git merge-tree failed: ${tree.stderr.trim()}`);
  const treeId = tree.stdout.split("\n")[0]!.trim();
  const intoSha = (await gitOrThrow(["rev-parse", into], repo)).trim();
  const branchSha = (await gitOrThrow(["rev-parse", branch], repo)).trim();
  const commit = (await gitOrThrow(["commit-tree", treeId, "-p", intoSha, "-p", branchSha, "-m", message], repo)).trim();
  await gitOrThrow(["update-ref", `refs/heads/${into}`, commit, intoSha], repo);
  return { ok: true, commit, method: "ref" };
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
): Promise<{ url: string; caughtUp?: string }> {
  const { branches, defaultBranch } = await remoteBranches(repo);
  if (!branches.includes(into)) {
    const instead = defaultBranch && defaultBranch !== into ? `, such as ${defaultBranch}` : "";
    throw new Error(`"${into}" isn't a branch on GitHub (it may have been merged and deleted), so a pull request can't go into it. Pick another branch${instead}.`);
  }
  const caughtUp = base ? await catchUpWithSquashedBase(repo, branch, into, base) : undefined;
  const push = await git(["push", "-u", "origin", branch], repo);
  if (push.code !== 0) throw new Error(`Pushing ${branch} failed: ${push.stderr.trim().split("\n").slice(-2).join(" ")}`);
  const out = await run("gh", ["pr", "create", "--base", into, "--head", branch, "--title", title, "--body", body], repo);
  const url = out.trim().split("\n").filter((l) => l.startsWith("http")).pop();
  if (!url) throw new Error(`gh didn't return a pull request URL: ${out.trim()}`);
  return { url, caughtUp };
}

/**
 * A run that started from a branch since squash-merged into `into` still carries that branch's
 * commits, and GitHub would show their changes again as part of the pull request. When `base`
 * adds nothing that origin's `into` doesn't already have, merge `into` into the result branch
 * (the files don't change) so the pull request shows only the run's commits. Returns the merge
 * commit, or undefined when nothing needed doing.
 */
async function catchUpWithSquashedBase(repo: string, branch: string, into: string, base: string): Promise<string | undefined> {
  const target = `refs/remotes/origin/${into}`;
  await gitOrThrow(["fetch", "--quiet", "origin", `+refs/heads/${into}:${target}`], repo);
  if ((await git(["merge-base", "--is-ancestor", base, target], repo)).code === 0) return undefined;
  const merged = await git(["merge-tree", "--write-tree", target, base], repo);
  if (merged.code !== 0) return undefined; // base has changes `into` doesn't: they belong in the pull request
  const targetTree = (await gitOrThrow(["rev-parse", `${target}^{tree}`], repo)).trim();
  if (merged.stdout.split("\n")[0]!.trim() !== targetTree) return undefined;
  const outcome = await mergeInto(repo, target, branch, `Merge origin/${into} into ${branch}`);
  if (!outcome.ok) {
    throw new Error(`origin/${into} conflicts with ${branch} in ${outcome.conflicts.join(", ")}. Merge it into the branch and resolve them, then open the pull request again.`);
  }
  return outcome.commit;
}

/** Remove a run's worktrees (branches are kept unless asked). Returns what was removed. */
export async function removeWorktrees(
  repo: string,
  worktrees: { path: string; branch: string }[],
  deleteBranches: boolean,
): Promise<{ removed: string[]; deletedBranches: string[] }> {
  const removed: string[] = [];
  const deletedBranches: string[] = [];
  for (const wt of worktrees) {
    if (existsSync(wt.path)) {
      const res = await git(["worktree", "remove", "--force", wt.path], repo);
      if (res.code === 0) removed.push(wt.path);
    }
    if (deleteBranches && (await git(["branch", "-D", wt.branch], repo)).code === 0) deletedBranches.push(wt.branch);
  }
  await git(["worktree", "prune"], repo);
  return { removed, deletedBranches };
}

async function gitOrThrow(args: string[], cwd: string): Promise<string> {
  const res = await git(args, cwd);
  if (res.code !== 0) throw new Error(`git ${args[0]} failed: ${res.stderr.trim() || res.stdout.trim()}`);
  return res.stdout;
}

function run(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${command} ${args[0]} ${args[1] ?? ""} failed: ${stderr.toString().trim() || err.message}`));
      else resolve(stdout.toString());
    });
  });
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
