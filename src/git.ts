import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

/** Folder inside every worktree that holds the user's context files for agents to read. */
export const CONTEXT_DIR = ".codeflow-context";

/**
 * Keep code-flow's folders out of `git status` and out of agents' commits by listing them
 * in .git/info/exclude. It is local to this clone (shared by all its worktrees) and never
 * committed, so your .gitignore is left alone.
 */
export async function ensureCodeflowExcludes(repo: string): Promise<void> {
  const patterns = [`/${CONTEXT_DIR}/`];
  const rel = relative(repo, worktreeRoot(repo));
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) patterns.unshift(`/${rel.split(sep).join("/")}/`);

  const excludeFile = resolve(repo, await gitOk(["rev-parse", "--git-path", "info/exclude"], repo));
  const current = await readFile(excludeFile, "utf8").catch(() => "");
  const existing = new Set(current.split("\n").map((line) => line.trim()));
  const missing = patterns.filter((p) => !existing.has(p));
  if (!missing.length) return;
  await mkdir(dirname(excludeFile), { recursive: true });
  const newline = current && !current.endsWith("\n") ? "\n" : "";
  await appendFile(excludeFile, `${newline}# code-flow\n${missing.join("\n")}\n`);
}

/** Run git with data on stdin (used for `check-ignore --stdin`). */
export function gitWithInput(args: string[], cwd: string, input: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
      resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() });
    });
    child.stdin?.end(input);
  });
}

/** "blob" or "tree" if `path` exists in commit `ref`, else null. */
export async function objectTypeAt(repo: string, ref: string, path: string): Promise<"blob" | "tree" | null> {
  const res = await git(["cat-file", "-t", `${ref}:${path}`], repo);
  const type = res.stdout.trim();
  return res.code === 0 && (type === "blob" || type === "tree") ? type : null;
}

/** True when the working-copy file differs from its version in commit `ref`. */
export async function workingCopyDiffers(repo: string, ref: string, path: string): Promise<boolean> {
  return (await git(["diff", "--quiet", ref, "--", path], repo)).code !== 0;
}

/**
 * A worktree at `path` on `branch`: reused if it already exists, re-attached if only the
 * branch survives (e.g. the folder was deleted), otherwise created from `fromRef`.
 */
export async function openWorktree(
  repo: string,
  name: string,
  path: string,
  branch: string,
  fromRef: string,
): Promise<{ wt: Worktree; created: boolean }> {
  const base = await resolveCommit(repo, fromRef);
  const wt = { name, path, branch, base };
  if (existsSync(join(path, ".git"))) return { wt, created: false };
  await mkdir(dirname(path), { recursive: true });
  if ((await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repo)).code === 0) {
    await git(["worktree", "prune"], repo);
    await gitOk(["worktree", "add", path, branch], repo);
    return { wt, created: false };
  }
  await gitOk(["worktree", "add", "-b", branch, path, fromRef], repo);
  return { wt, created: true };
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

export async function uncommittedCount(cwd: string): Promise<number> {
  const out = await gitOk(["status", "--porcelain"], cwd);
  return out ? out.split("\n").length : 0;
}

/** Drop uncommitted changes and untracked (non-ignored) files in a disposable worktree. */
export async function discardChanges(cwd: string): Promise<void> {
  await gitOk(["reset", "--hard", "-q", "HEAD"], cwd);
  await gitOk(["clean", "-fdq"], cwd);
}

/** A worktree's state before a read-only step: its commit, uncommitted changes, untracked files. */
export interface Snapshot {
  head: string;
  /** `git stash create` of the uncommitted changes ("" when there are none); nothing is stashed. */
  changes: string;
  untracked: string[];
}

async function uncommittedTree(cwd: string): Promise<string> {
  const sha = (await gitOk(["stash", "create"], cwd)).trim();
  return sha ? (await gitOk(["rev-parse", `${sha}^{tree}`], cwd)).trim() : "";
}

const untrackedFiles = async (cwd: string) => (await gitOk(["ls-files", "--others", "--exclude-standard", "-z"], cwd)).split("\0").filter(Boolean);

export async function snapshot(cwd: string): Promise<Snapshot> {
  return {
    head: await resolveCommit(cwd),
    changes: (await gitOk(["stash", "create"], cwd)).trim(),
    untracked: await untrackedFiles(cwd),
  };
}

/**
 * Put a worktree back the way `snapshot` found it, undoing whatever a read-only step did:
 * commits, edits, new files. Returns what was undone (empty when nothing changed).
 */
export async function restoreSnapshot(cwd: string, snap: Snapshot): Promise<string[]> {
  const undone: string[] = [];
  const head = await resolveCommit(cwd);
  const changesNow = await uncommittedTree(cwd);
  const changesBefore = snap.changes ? (await gitOk(["rev-parse", `${snap.changes}^{tree}`], cwd)).trim() : "";
  if (head !== snap.head) undone.push("commits");
  if (head !== snap.head || changesNow !== changesBefore) {
    if (head === snap.head) undone.push("edits");
    await gitOk(["reset", "--hard", "-q", snap.head], cwd);
    if (snap.changes) await gitOk(["stash", "apply", "-q", snap.changes], cwd);
  }
  const before = new Set(snap.untracked);
  const added = (await untrackedFiles(cwd)).filter((f) => !before.has(f));
  if (added.length) {
    undone.push(`${added.length} new file${added.length === 1 ? "" : "s"}`);
    for (let i = 0; i < added.length; i += 100) await gitOk(["clean", "-fq", "--", ...added.slice(i, i + 100)], cwd);
  }
  return undone;
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repo)).code === 0;
}

/** True when commit `a` is `b` or one of its ancestors. */
export async function isAncestor(cwd: string, a: string, b = "HEAD"): Promise<boolean> {
  return (await git(["merge-base", "--is-ancestor", a, b], cwd)).code === 0;
}

/** Put `paths` back to how they are in `ref` (deleting the ones `ref` doesn't have). */
export async function restorePaths(cwd: string, ref: string, paths: string[]): Promise<void> {
  for (const path of paths) {
    if (await objectTypeAt(cwd, ref, path)) await gitOk(["checkout", ref, "--", path], cwd);
    else await git(["rm", "-q", "-f", "--ignore-unmatch", "--", path], cwd);
  }
}

/** A ref the user named (e.g. a branch to merge): must exist and can't be read as an option. */
export async function validRef(repo: string, ref: string): Promise<boolean> {
  return !!ref && !ref.startsWith("-") && (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repo)).code === 0;
}

export async function hasConflictMarkers(wt: Worktree): Promise<boolean> {
  const res = await git(["diff", "--check"], wt.path);
  return /conflict marker/i.test(res.stdout + res.stderr);
}
