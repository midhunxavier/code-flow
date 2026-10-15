import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { CODEFLOW_HOME } from "./config.js";

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

function worktreeRoot(repo: string): string {
  const id = createHash("sha1").update(repo).digest("hex").slice(0, 8);
  return join(CODEFLOW_HOME, "worktrees", `${basename(repo)}-${id}`);
}

/** Create `codeflow/<runId>/<name>` checked out in a worktree outside the repo. */
export async function createWorktree(repo: string, runId: string, name: string, fromRef: string): Promise<Worktree> {
  const path = join(worktreeRoot(repo), runId, name);
  const branch = `codeflow/${runId}/${name}`;
  await mkdir(join(worktreeRoot(repo), runId), { recursive: true });
  await gitOk(["worktree", "add", "-b", branch, path, fromRef], repo);
  return { name, path, branch, base: await resolveCommit(repo, fromRef) };
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
