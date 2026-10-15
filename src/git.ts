import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { WORKTREE_DIR } from "./config.js";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function git(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
      resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

async function gitOk(args: string[], cwd: string): Promise<string> {
  const res = await git(args, cwd);
  if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr.trim() || res.stdout.trim()}`);
  return res.stdout.trim();
}

export async function repoRoot(path: string): Promise<string> {
  return gitOk(["rev-parse", "--show-toplevel"], path);
}

export async function resolveCommit(repo: string, ref = "HEAD"): Promise<string> {
  return gitOk(["rev-parse", "--verify", `${ref}^{commit}`], repo);
}

export interface Worktree {
  name: string;
  path: string;
  branch: string;
  /** Commit the worktree was created from. */
  base: string;
}

// Agents commit as this identity so their work is clearly attributed in history.
const IDENTITY = ["-c", "user.name=code-flow", "-c", "user.email=code-flow@localhost"];

/** `<repo>/.worktrees` by default; see WORKTREE_DIR. */
export function worktreeRoot(repo: string): string {
  return resolve(repo, WORKTREE_DIR);
}

/**
 * Keep in-repo worktrees out of `git status` by listing the folder in .git/info/exclude,
 * which is local to this clone and never committed (your .gitignore is left alone).
 */
export async function ensureWorktreeDirExcluded(repo: string): Promise<void> {
  const rel = relative(repo, worktreeRoot(repo));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return;
  const pattern = `/${rel.split(sep).join("/")}/`;
  const excludeFile = resolve(repo, await gitOk(["rev-parse", "--git-path", "info/exclude"], repo));
  const current = await readFile(excludeFile, "utf8").catch(() => "");
  if (current.split("\n").some((line) => line.trim() === pattern)) return;
  await mkdir(dirname(excludeFile), { recursive: true });
  const newline = current && !current.endsWith("\n") ? "\n" : "";
  await appendFile(excludeFile, `${newline}# code-flow worktrees\n${pattern}\n`);
}

/** Create a new branch from `fromRef` and check it out in a worktree at `path`. */
export async function createWorktree(repo: string, name: string, path: string, branch: string, fromRef: string): Promise<Worktree> {
  await mkdir(dirname(path), { recursive: true });
  await gitOk(["worktree", "add", "-b", branch, path, fromRef], repo);
  return { name, path, branch, base: await resolveCommit(repo, fromRef) };
}

export interface BranchInfo {
  name: string;
  /** local branch, remote-tracking branch, or a result branch from an earlier code-flow run */
  kind: "local" | "remote" | "run";
  updated: string;
}

export async function listBranches(repo: string): Promise<{ current: string | null; branches: BranchInfo[] }> {
  const out = await gitOk(
    [
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname)%09%(refname:short)%09%(committerdate:relative)",
      "refs/heads",
      "refs/remotes",
    ],
    repo,
  );
  const branches: BranchInfo[] = [];
  for (const line of out.split("\n").filter(Boolean)) {
    const [ref = "", name = "", updated = ""] = line.split("\t");
    if (ref.startsWith("refs/remotes/") && ref.endsWith("/HEAD")) continue;
    const kind = ref.startsWith("refs/remotes/") ? "remote" : ref.startsWith("refs/heads/codeflow/") ? "run" : "local";
    branches.push({ name, kind, updated });
  }
  const head = await git(["symbolic-ref", "--short", "-q", "HEAD"], repo);
  return { current: head.code === 0 ? head.stdout.trim() : null, branches };
}

/** Result branches are `<prefix>/<worktree name>`, so the prefix must be a free ref namespace. */
export async function validateBranchPrefix(repo: string, prefix: string): Promise<void> {
  if ((await git(["check-ref-format", "--branch", `${prefix}/x`], repo)).code !== 0) {
    throw new Error(`"${prefix}" is not a valid branch name prefix`);
  }
  if ((await git(["show-ref", "--verify", "--quiet", `refs/heads/${prefix}`], repo)).code === 0) {
    throw new Error(`A branch named "${prefix}" already exists, so "${prefix}/…" branches can't be created`);
  }
  if (await gitOk(["for-each-ref", "--count=1", "--format=%(refname:short)", `refs/heads/${prefix}/`], repo)) {
    throw new Error(`Branches under "${prefix}/" already exist; pick another prefix`);
  }
}

/** Stage and commit everything in the worktree. Returns the new commit, or null if clean. */
export async function commitAll(wt: Worktree, message: string): Promise<string | null> {
  await gitOk(["add", "-A"], wt.path);
  const staged = await git(["diff", "--cached", "--quiet"], wt.path);
  const merging = (await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], wt.path)).code === 0;
  if (staged.code === 0 && !merging) return null;
  await gitOk([...IDENTITY, "commit", "--no-verify", "-m", message], wt.path);
  return resolveCommit(wt.path);
}

export async function diffSince(wt: Worktree, base = wt.base): Promise<string> {
  return gitOk(["diff", "--no-color", `${base}..HEAD`], wt.path);
}

export async function diffStat(wt: Worktree, base = wt.base): Promise<string> {
  return gitOk(["diff", "--stat", "--no-color", `${base}..HEAD`], wt.path);
}

export async function changedFiles(cwd: string, from: string, to = "HEAD"): Promise<string[]> {
  const out = await gitOk(["diff", "--name-only", `${from}..${to}`], cwd);
  return out ? out.split("\n") : [];
}

export interface MergeResult {
  ok: boolean;
  conflicts: string[];
  output: string;
}

export async function mergeBranch(wt: Worktree, branch: string): Promise<MergeResult> {
  const res = await git([...IDENTITY, "merge", "--no-ff", "--no-edit", branch], wt.path);
  if (res.code === 0) return { ok: true, conflicts: [], output: res.stdout };
  const conflicts = await git(["diff", "--name-only", "--diff-filter=U"], wt.path);
  return {
    ok: false,
    conflicts: conflicts.stdout.trim().split("\n").filter(Boolean),
    output: `${res.stdout}\n${res.stderr}`.trim(),
  };
}

export async function isClean(cwd: string): Promise<boolean> {
  return (await gitOk(["status", "--porcelain"], cwd)) === "";
}

/** Drop uncommitted changes and untracked (non-ignored) files in a disposable worktree. */
export async function discardChanges(cwd: string): Promise<void> {
  await gitOk(["reset", "--hard", "-q", "HEAD"], cwd);
  await gitOk(["clean", "-fdq"], cwd);
}

export async function hasConflictMarkers(wt: Worktree): Promise<boolean> {
  const res = await git(["diff", "--check"], wt.path);
  return /conflict marker/i.test(res.stdout + res.stderr);
}
