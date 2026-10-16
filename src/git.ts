import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { envNumber, timerMs, WORKTREE_DIR } from "./config.js";
import { childEnv } from "./env.js";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Killed for taking longer than its timeout. */
  timedOut?: boolean;
  /** Stopped by its abort signal. */
  aborted?: boolean;
}

export interface GitOptions {
  /** Default CODEFLOW_GIT_TIMEOUT_SEC (5 minutes). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Added to the environment every git call gets. */
  env?: NodeJS.ProcessEnv;
  /** Written to stdin. */
  input?: string;
}

const GIT_TIMEOUT_MS = timerMs(envNumber("CODEFLOW_GIT_TIMEOUT_SEC", 300, { min: 1 }) * 1000);
const GIT_MAX_OUTPUT = 64 * 1024 * 1024;

/**
 * Every git code-flow runs: never waits on a prompt (a credential prompt would hang a push for
 * good), takes no optional locks (so a `git status` for the Files panel can't block your own
 * git), and prints its messages in English (code-flow reads some of them).
 */
function gitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return childEnv({ GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_OPTIONAL_LOCKS: "0", LANGUAGE: "C", LC_MESSAGES: "C", ...extra });
}

/**
 * Run git. Never throws: a non-zero `code` says it failed. Bounded in time (a hook, an LFS
 * fetch or a stalled remote can't hang a run) and in output (a huge diff fails cleanly instead
 * of ending up in an error message).
 */
export function git(args: string[], cwd: string, opts: GitOptions = {}): Promise<GitResult> {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  return new Promise((resolve) => {
    // Its own process group, so a timeout also stops the hooks (and their children) git started.
    const child = spawn("git", args, { cwd, env: gitEnv(opts.env), detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let overflow = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const kill = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    timer.unref();
    const onAbort = () => {
      aborted = true;
      kill();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    child.stdout.on("data", (chunk: Buffer) => {
      if (overflow) return;
      outBytes += chunk.length;
      if (outBytes > GIT_MAX_OUTPUT) {
        overflow = true;
        kill();
      } else out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errBytes > 1024 * 1024) return;
      errBytes += chunk.length;
      err.push(chunk);
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const stdout = Buffer.concat(out).toString();
      const stderr = Buffer.concat(err).toString();
      if (overflow) resolve({ code: 1, stdout: "", stderr: `git ${args[0]} printed more than ${GIT_MAX_OUTPUT / 1024 / 1024} MB` });
      else if (aborted) resolve({ code: 1, stdout: "", stderr: `git ${args[0]} was cancelled`, aborted: true });
      else if (timedOut) resolve({ code: 1, stdout, stderr: `git ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s\n${stderr}`.trim(), timedOut: true });
      else resolve({ code: exitCode ?? 1, stdout, stderr });
    };
    child.on("error", (e) => {
      err.push(Buffer.from(e.message));
      finish(1);
    });
    child.on("close", (code) => finish(code));
    // Something a hook started can hold the pipes open after git itself has exited.
    child.on("exit", (code) => {
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code);
      }, 2_000).unref();
    });
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input);
  });
}

/** git's error text, short enough for a log line or a run's error. */
export function gitError(args: string[], res: GitResult): string {
  const text = (res.stderr.trim() || res.stdout.trim()).slice(0, 2_000);
  return `git ${args.join(" ").slice(0, 200)} failed: ${text}`;
}

async function gitOk(args: string[], cwd: string, opts?: GitOptions): Promise<string> {
  const res = await git(args, cwd, opts);
  if (res.code !== 0) throw new Error(gitError(args, res));
  return res.stdout.trim();
}

/** Why a git command failed, for an error that says what to do instead of "would conflict". */
export type GitFailure = "locked" | "untracked" | "dirty" | "conflict" | "hook" | "identity" | "auth" | "timeout" | "other";

export function classifyGitFailure(res: GitResult): GitFailure {
  if (res.timedOut) return "timeout";
  const text = `${res.stderr}\n${res.stdout}`;
  if (/index\.lock|Unable to create '.*\.lock'|another git process seems to be running/i.test(text)) return "locked";
  if (/untracked working tree files would be (?:overwritten|removed)/i.test(text)) return "untracked";
  if (/local changes to the following files would be overwritten|Please commit your changes or stash them/i.test(text)) return "dirty";
  if (/^CONFLICT|Automatic merge failed|fix conflicts and then commit/im.test(text)) return "conflict";
  if (/Please tell me who you are|unable to auto-detect email address|empty ident name/i.test(text)) return "identity";
  if (/Authentication failed|could not read (?:Username|Password)|terminal prompts disabled|Permission denied \(publickey|returned error: 403|Repository not found/i.test(text)) return "auth";
  if (/hook\b.*(?:failed|declined|exit)|(?:pre|post)-\w+ hook/i.test(text)) return "hook";
  return "other";
}

/** A plain-language reason for a classified failure. */
export function describeGitFailure(kind: GitFailure): string {
  switch (kind) {
    case "locked":
      return "another git process is using this repository (an index.lock exists); try again when it finishes";
    case "untracked":
      return "untracked files in your checkout would be overwritten";
    case "dirty":
      return "your checkout has uncommitted changes that would be overwritten";
    case "conflict":
      return "the branches conflict";
    case "hook":
      return "a git hook failed";
    case "identity":
      return "git doesn't know your name and email (set user.name and user.email)";
    case "auth":
      return "git couldn't sign in to the remote (check your credentials)";
    case "timeout":
      return "git took too long";
    default:
      return "git failed";
  }
}

let versionPromise: Promise<[number, number, number] | undefined> | undefined;

/** The installed git's version, e.g. [2, 39, 3]; undefined if it can't be read. */
export function gitVersion(): Promise<[number, number, number] | undefined> {
  const pending = (versionPromise ??= git(["--version"], process.cwd(), { timeoutMs: 10_000 }).then((res) => {
    const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(res.stdout);
    return m ? ([Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] as [number, number, number]) : undefined;
  }));
  // Only a version that was read is kept: one slow `git --version` mustn't block merges until a restart.
  void pending.then((v) => {
    if (!v && versionPromise === pending) versionPromise = undefined;
  });
  return pending;
}

/** True when the installed git is at least `major.minor`. */
export async function gitAtLeast(major: number, minor: number): Promise<boolean> {
  const v = await gitVersion();
  return !!v && (v[0] > major || (v[0] === major && v[1] >= minor));
}

/** Run `fn` after everything queued under `key` in `locks`, one at a time. */
function serialize<T>(locks: Map<string, Promise<unknown>>, key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  const tail = next.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return next;
}

const repoLocks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` while no other code-flow operation is changing `repo`'s worktrees or refs (creating
 * or removing worktrees, deleting branches, merging into your checkout). Concurrent runs on
 * one repo otherwise trip over each other's `.git` lock files.
 */
export function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  return serialize(repoLocks, resolve(repo), fn);
}

const worktreeLocks = new Map<string, Promise<unknown>>();

/** Snapshots and restores of one worktree, one at a time (read-only steps can share a worktree). */
function withWorktreeLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  return serialize(worktreeLocks, resolve(cwd), fn);
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
  return git(args, cwd, { input });
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

/** Cloning submodules can take far longer than other git calls. */
const SUBMODULE_TIMEOUT_MS = 10 * 60_000;

/**
 * `git worktree add` leaves submodule folders empty, so setup and checks would fail. Registering
 * them (`submodule init`) writes the repo's shared config, so it runs under the repo lock;
 * cloning them (`submodule update`) can take minutes and runs outside it. Both return a
 * warning instead of failing: a worktree without its submodules can still be worked in.
 */
async function registerSubmodules(path: string): Promise<string | undefined> {
  if (!existsSync(join(path, ".gitmodules"))) return undefined;
  const args = ["submodule", "init"];
  const res = await git(args, path);
  return res.code === 0 ? undefined : submoduleWarning(path, args, res);
}

async function updateSubmodules(path: string, signal?: AbortSignal): Promise<string | undefined> {
  if (!existsSync(join(path, ".gitmodules"))) return undefined;
  const args = ["submodule", "update", "--init", "--recursive"];
  const res = await git(args, path, { timeoutMs: SUBMODULE_TIMEOUT_MS, signal });
  return res.code === 0 ? undefined : submoduleWarning(path, args, res);
}

const submoduleWarning = (path: string, args: string[], res: GitResult) =>
  `Submodules weren't checked out in ${path}, so setup and checks that need them may fail. ${gitError(args, res)}`;

/**
 * A worktree at `path` on `branch`: reused if it already exists, re-attached if only the
 * branch survives (e.g. the folder was deleted), otherwise created from `fromRef`. A new or
 * re-attached checkout gets its submodules; `warning` says when that failed.
 */
export async function openWorktree(
  repo: string,
  name: string,
  path: string,
  branch: string,
  fromRef: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ wt: Worktree; created: boolean; warning?: string }> {
  const base = await resolveCommit(repo, fromRef);
  const wt = { name, path, branch, base };
  if (existsSync(join(path, ".git"))) return { wt, created: false };
  const opened = await withRepoLock(repo, async () => {
    await mkdir(dirname(path), { recursive: true });
    let created = false;
    if ((await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repo)).code === 0) {
      await git(["worktree", "prune"], repo);
      await gitOk(["worktree", "add", path, branch], repo);
    } else {
      await gitOk(["worktree", "add", "-b", branch, path, fromRef], repo);
      created = true;
    }
    return { created, warning: await registerSubmodules(path) };
  });
  const warning = opened.warning ?? (await updateSubmodules(path, opts.signal));
  return warning ? { wt, created: opened.created, warning } : { wt, created: opened.created };
}

/** A throwaway checkout of `ref` on no branch (e.g. to run the check on the base commit), with its submodules. */
export async function openDetachedWorktree(repo: string, path: string, ref: string, opts: { signal?: AbortSignal } = {}): Promise<{ warning?: string }> {
  await removeDetachedWorktree(repo, path);
  const registered = await withRepoLock(repo, async () => {
    await mkdir(dirname(path), { recursive: true });
    await gitOk(["worktree", "add", "--detach", path, ref], repo);
    return registerSubmodules(path);
  });
  const warning = registered ?? (await updateSubmodules(path, opts.signal));
  return warning ? { warning } : {};
}

export async function removeDetachedWorktree(repo: string, path: string): Promise<void> {
  await withRepoLock(repo, async () => {
    if (existsSync(path)) await git(["worktree", "remove", "--force", path], repo);
    await rm(path, { recursive: true, force: true });
    await git(["worktree", "prune"], repo);
  });
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

/**
 * `git stash create` against a copy of the worktree's index: it refreshes the index, which
 * takes `index.lock` and fails (silently, exit 1) when the lock is held. On a copy, read-only
 * steps side by side in one worktree, an agent's own git, or yours never collide with it.
 */
async function stashCreate(cwd: string): Promise<string> {
  const index = resolve(cwd, await gitOk(["rev-parse", "--git-path", "index"], cwd));
  const copy = `${index}.codeflow-${process.pid}-${randomBytes(4).toString("hex")}`;
  const copied = await copyFile(index, copy).then(() => true, () => false);
  const env = copied ? { env: { GIT_INDEX_FILE: copy } } : undefined;
  try {
    // Refreshed first: a file touched but unchanged makes `stash create` see a change, then none
    // once it refreshes, and exit 1 with nothing printed. (On the real index, the first call's
    // refresh hid that; a copy is stale every time.)
    if (copied) await git(["update-index", "-q", "--refresh"], cwd, env);
    return (await gitOk(["stash", "create"], cwd, env)).trim();
  } finally {
    if (copied) await Promise.all([rm(copy, { force: true }), rm(`${copy}.lock`, { force: true })]);
  }
}

/** gitOk, tried again for a few seconds while another git process holds a lock (an agent's, yours). */
async function gitOkWhenFree(args: string[], cwd: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const res = await git(args, cwd);
    if (res.code === 0) return res.stdout.trim();
    if (attempt >= 5 || classifyGitFailure(res) !== "locked") throw new Error(gitError(args, res));
    await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
  }
}

async function uncommittedTree(cwd: string): Promise<string> {
  const sha = await stashCreate(cwd);
  return sha ? (await gitOk(["rev-parse", `${sha}^{tree}`], cwd)).trim() : "";
}

const untrackedFiles = async (cwd: string) => (await gitOk(["ls-files", "--others", "--exclude-standard", "-z"], cwd)).split("\0").filter(Boolean);

export async function snapshot(cwd: string): Promise<Snapshot> {
  return withWorktreeLock(cwd, async () => ({
    head: await resolveCommit(cwd),
    changes: await stashCreate(cwd),
    untracked: await untrackedFiles(cwd),
  }));
}

/**
 * Put a worktree back the way `snapshot` found it, undoing whatever a read-only step did:
 * commits, edits, new files. Returns what was undone (empty when nothing changed).
 */
export async function restoreSnapshot(cwd: string, snap: Snapshot): Promise<string[]> {
  return withWorktreeLock(cwd, async () => {
    const undone: string[] = [];
    const head = await resolveCommit(cwd);
    const changesNow = await uncommittedTree(cwd);
    const changesBefore = snap.changes ? (await gitOk(["rev-parse", `${snap.changes}^{tree}`], cwd)).trim() : "";
    if (head !== snap.head) undone.push("commits");
    if (head !== snap.head || changesNow !== changesBefore) {
      if (head === snap.head) undone.push("edits");
      await gitOkWhenFree(["reset", "--hard", "-q", snap.head], cwd);
      if (snap.changes) await gitOkWhenFree(["stash", "apply", "-q", snap.changes], cwd);
    }
    const before = new Set(snap.untracked);
    const added = (await untrackedFiles(cwd)).filter((f) => !before.has(f));
    if (added.length) {
      undone.push(`${added.length} new file${added.length === 1 ? "" : "s"}`);
      for (let i = 0; i < added.length; i += 100) await gitOkWhenFree(["clean", "-fq", "--", ...added.slice(i, i + 100)], cwd);
    }
    return undone;
  });
}

/** A merge is in progress (conflicts being resolved): starting over would lose it. */
export async function isMerging(cwd: string): Promise<boolean> {
  return (await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], cwd)).code === 0;
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
