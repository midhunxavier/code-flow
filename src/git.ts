import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { appendFile, copyFile, lstat, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  /** Look for the repository in the folders above `cwd` too: only to find the one a folder you picked is in. */
  discover?: boolean;
  /** Run the repository's hooks: only for a merge into your checkout and a push (see gitCommand). */
  hooks?: boolean;
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
 * A checkout and the git folder code-flow found for it from your repository's side (see
 * worktreeGit). git run with one gets both (GIT_DIR, GIT_WORK_TREE), so it never reads the
 * checkout's own `.git`: an agent can rewrite that file, and the git folder it then names could
 * hold a config whose filter, textconv or external diff code-flow would run outside the agent's
 * sandbox, even for a `git status`.
 */
export interface Checkout {
  /** Its folder (real path). */
  readonly path: string;
  readonly gitDir: string;
}

/** Where git runs: a folder, whose repository git finds itself (never above it), or a Checkout. */
export type GitCwd = string | Checkout;

const folderOf = (cwd: GitCwd) => (typeof cwd === "string" ? cwd : cwd.path);

/**
 * The arguments and environment for code-flow's own git in `cwd`:
 * - git looks for the repository in `cwd` and nowhere above it (GIT_CEILING_DIRECTORIES). A
 *   worktree lives inside your checkout, and once an agent deletes its `.git`, git run there
 *   would find your checkout instead: a `reset --hard` meant for the worktree would reset yours.
 *   In a Checkout git doesn't look at all: it's told the git folder.
 * - no fsmonitor and no hooks, whatever a config file says. An agent can point a worktree's
 *   `.git` at a git folder of its own making, whose config would otherwise have code-flow run
 *   the agent's commands outside its sandbox. Your hooks still run where you'd expect them to:
 *   a merge into your checkout and a push (Git LFS uploads its files in pre-push).
 */
function gitCommand(args: string[], cwd: GitCwd, opts: GitOptions = {}): { args: string[]; env: NodeJS.ProcessEnv } {
  const own = ["-c", "core.fsmonitor=false", ...(opts.hooks ? [] : ["-c", "core.hooksPath=/dev/null"])];
  const ceiling = opts.discover ? {} : { GIT_CEILING_DIRECTORIES: dirname(realPathSync(folderOf(cwd))) };
  const pinned = typeof cwd === "string" ? {} : { GIT_DIR: cwd.gitDir, GIT_WORK_TREE: cwd.path };
  return { args: [...own, ...args], env: gitEnv({ ...ceiling, ...pinned, ...opts.env }) };
}

function realPathSync(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

const realPath = (path: string) => realpath(path).catch(() => resolve(path));

/**
 * Run git. Never throws: a non-zero `code` says it failed. Bounded in time (a hook, an LFS
 * fetch or a stalled remote can't hang a run) and in output (a huge diff fails cleanly instead
 * of ending up in an error message).
 */
export function git(args: string[], cwd: GitCwd, opts: GitOptions = {}): Promise<GitResult> {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const command = gitCommand(args, cwd, opts);
    // Its own process group, so a timeout also stops the hooks (and their children) git started.
    const child = spawn("git", command.args, { cwd: folderOf(cwd), env: command.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
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

async function gitOk(args: string[], cwd: GitCwd, opts?: GitOptions): Promise<string> {
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
  return gitOk(["rev-parse", "--show-toplevel"], path, { discover: true });
}

export async function resolveCommit(repo: GitCwd, ref = "HEAD"): Promise<string> {
  return gitOk(["rev-parse", "--verify", `${ref}^{commit}`], repo);
}

export interface Worktree {
  name: string;
  path: string;
  branch: string;
  /** Commit the worktree was created from. */
  base: string;
}

/** A checkout to change: its folder, and the branch it must be on (none for a detached one). */
export type CheckoutRef = { path: string; branch?: string };

/** A checkout that isn't the one code-flow means to change (see assertWorktree). */
export class WorktreeMismatchError extends Error {}

/**
 * The checkout of `repo` at `path`, for code-flow's git (see Checkout). Its git folder is found
 * from `repo`'s side, where agents can't write: the folder in `repo`'s git folder whose `gitdir`
 * file names `path`'s `.git` (`repo`'s git folder itself for its main checkout). `path`'s own
 * `.git` is at most a hint at which one to try first. Throws a WorktreeMismatchError when `repo`
 * has no checkout at `path`.
 *
 * This doesn't check `.git` itself: reads work in a worktree whose `.git` an agent broke. Before
 * changing a checkout, use assertWorktree.
 */
export async function worktreeGit(repo: string, path: string): Promise<Checkout> {
  const found = await findGitDir(repo, path);
  if (!found.gitDir) {
    throw new WorktreeMismatchError(`${path} isn't a checkout of ${repo} (no git folder of ${repo}'s names it), so code-flow didn't run git there.`);
  }
  return { path: found.path, gitDir: found.gitDir };
}

/** `repo`'s git folder (shared by its worktrees), its real path. */
async function commonDir(repo: string): Promise<string> {
  return realPath(resolve(repo, await gitOk(["rev-parse", "--git-common-dir"], repo)));
}

/** The path, through any links on the way but not a link at the end (an agent may have made `.git` one). */
const realPathOfEntry = async (path: string) => join(await realPath(dirname(path)), basename(path));

/** The git folder a `.git` file names (its real path); undefined when it isn't a small regular file naming one. */
async function namedGitDir(dotGit: string): Promise<string | undefined> {
  const info = await lstat(dotGit).catch(() => undefined);
  if (!info?.isFile() || info.size > 4096) return undefined;
  const named = /^gitdir: *(.+?)\s*$/m.exec(await readFile(dotGit, "utf8").catch(() => ""))?.[1];
  return named ? realPath(resolve(dirname(dotGit), named)) : undefined;
}

/** A worktree's git folder in `repo`'s names `dotGit` as its checkout's `.git` (git's back-link). */
async function namesCheckout(gitDir: string, dotGit: string): Promise<boolean> {
  const back = (await readFile(join(gitDir, "gitdir"), "utf8").catch(() => "")).trim();
  return !!back && (await realPathOfEntry(resolve(gitDir, back))) === dotGit;
}

async function findGitDir(repo: string, path: string): Promise<{ path: string; common: string; gitDir?: string }> {
  const common = await commonDir(repo);
  const real = await realPath(path);
  const dotGit = join(real, ".git");
  const worktrees = join(common, "worktrees");
  const hint = await namedGitDir(dotGit);
  if (hint && dirname(hint) === worktrees && (await namesCheckout(hint, dotGit))) return { path: real, common, gitDir: hint };
  for (const entry of await readdir(worktrees).catch(() => [])) {
    if (await namesCheckout(join(worktrees, entry), dotGit)) return { path: real, common, gitDir: join(worktrees, entry) };
  }
  const main = await mainWorktree(repo);
  return { path: real, common, gitDir: main && (await realPath(main)) === real ? common : undefined };
}

/**
 * Before code-flow changes a checkout of `repo` (resets it, cleans it, puts a stash back, commits,
 * merges, removes it), or starts an agent there: make sure git acts on that checkout and nothing
 * else. Returns it (see worktreeGit), for the git that does the changing: that git uses the git
 * folder checked here, whatever `.git` says by the time it runs.
 *
 * An agent can delete or rewrite the worktree's `.git` (it's a file in the worktree), and git
 * would then act on your checkout above it, or on a repository of the agent's making: the
 * agent's own git, and code-flow's before it was given the git folder. Throws, saying what's
 * wrong, instead. What it checks:
 * - `.git` is the file git wrote, naming the worktree's folder in `repo`'s git folder, which
 *   names it back (an agent can't write there). For your main checkout, `.git` is `repo`'s git
 *   folder itself.
 * - with `wt.branch`, HEAD is that branch: a reset or commit on another one would change it.
 */
export async function assertWorktree(repo: string, wt: CheckoutRef): Promise<Checkout> {
  const found = await findGitDir(repo, wt.path);
  const problem = await dotGitProblem(repo, found);
  const checkout = found.gitDir && !problem ? { path: found.path, gitDir: found.gitDir } : undefined;
  const branchProblem = checkout && wt.branch ? await headProblem(checkout, wt.branch) : undefined;
  if (!checkout || branchProblem) {
    throw new WorktreeMismatchError(
      `${wt.path} isn't the checkout code-flow expects (${problem ?? branchProblem ?? `no git folder of ${repo}'s names it`}), so code-flow didn't run git there: it could have changed another checkout or branch, such as yours. Nothing was changed.`,
    );
  }
  return checkout;
}

/** What's wrong with a checkout's `.git`, which should name `found.gitDir`. */
async function dotGitProblem(repo: string, found: { path: string; common: string; gitDir?: string }): Promise<string | undefined> {
  const dotGit = join(found.path, ".git");
  const info = await lstat(dotGit).catch(() => undefined);
  if (!info) return "its .git is missing";
  let named: string;
  if (info.isDirectory()) named = await realPath(dotGit);
  else if (info.isFile()) {
    const gitDir = await namedGitDir(dotGit);
    if (!gitDir) return "its .git doesn't name a git folder";
    named = gitDir;
  } else return `its .git is a ${info.isSymbolicLink() ? "symbolic link" : "special file"}`;
  if (named === found.gitDir) return undefined;

  if (named === found.common) return `its .git points to the git folder of ${(await mainWorktree(repo)) ?? repo} itself`;
  if (dirname(named) === join(found.common, "worktrees")) {
    return existsSync(join(named, "gitdir")) ? `its .git points to the git folder of another worktree (${named})` : `its .git points to ${named}, which isn't there any more`;
  }
  return `its .git points to ${named}, which isn't one of ${repo}'s worktrees`;
}

async function headProblem(checkout: Checkout, branch: string): Promise<string | undefined> {
  const head = (await git(["symbolic-ref", "-q", "HEAD"], checkout)).stdout.trim();
  if (head === `refs/heads/${branch}`) return undefined;
  return head ? `it's on ${head.replace(/^refs\/heads\//, "")}, not ${branch}` : `its HEAD is detached, not on ${branch}`;
}

/** `repo`'s main checkout (the one its git folder belongs to); undefined for a bare repository. */
async function mainWorktree(repo: string): Promise<string | undefined> {
  const lines = (await gitOk(["worktree", "list", "--porcelain"], repo)).split("\n");
  const end = lines.indexOf("");
  const first = lines.slice(0, end === -1 ? undefined : end);
  return first.includes("bare") ? undefined : first.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
}

// Agents commit as this identity so their work is clearly attributed in history.
const IDENTITY = ["-c", "user.name=code-flow", "-c", "user.email=code-flow@localhost"];

/**
 * code-flow's diffs are git's own: never an external diff program or a textconv filter, which a
 * config can name (and a `.gitattributes` in the worktree pick) to run commands, and whose
 * output code-flow couldn't read as a diff anyway.
 */
const RAW_DIFF = ["--no-ext-diff", "--no-textconv"];

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
export function gitWithInput(args: string[], cwd: GitCwd, input: string): Promise<GitResult> {
  return git(args, cwd, { input });
}

/** "blob" or "tree" if `path` exists in commit `ref`, else null. */
export async function objectTypeAt(repo: GitCwd, ref: string, path: string): Promise<"blob" | "tree" | null> {
  const res = await git(["cat-file", "-t", `${ref}:${path}`], repo);
  const type = res.stdout.trim();
  return res.code === 0 && (type === "blob" || type === "tree") ? type : null;
}

/** True when the working-copy file differs from its version in commit `ref`. */
export async function workingCopyDiffers(repo: GitCwd, ref: string, path: string): Promise<boolean> {
  return (await git(["diff", "--quiet", ...RAW_DIFF, ref, "--", path], repo)).code !== 0;
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

/** Stage and commit everything in a worktree of `repo`. Returns the new commit, or null if clean. */
export async function commitAll(repo: string, wt: Worktree, message: string): Promise<string | null> {
  const at = await assertWorktree(repo, wt);
  await gitOk(["add", "-A"], at);
  const staged = await git(["diff", "--cached", "--quiet", ...RAW_DIFF], at);
  if (staged.code === 0 && !(await isMerging(at))) return null;
  await gitOk([...IDENTITY, "commit", "--no-verify", "-m", message], at);
  return resolveCommit(at);
}

/** The change on a checkout's branch since `base`, as a patch. */
export async function diffSince(at: GitCwd, base: string): Promise<string> {
  return gitOk(["diff", "--no-color", ...RAW_DIFF, `${base}..HEAD`], at);
}

export async function diffStat(at: GitCwd, base: string): Promise<string> {
  return gitOk(["diff", "--stat", "--no-color", ...RAW_DIFF, `${base}..HEAD`], at);
}

export async function changedFiles(cwd: GitCwd, from: string, to = "HEAD"): Promise<string[]> {
  const out = await gitOk(["diff", "--name-only", ...RAW_DIFF, `${from}..${to}`], cwd);
  return out ? out.split("\n") : [];
}

export interface MergeResult {
  ok: boolean;
  conflicts: string[];
  output: string;
}

export async function mergeBranch(repo: string, wt: Worktree, branch: string): Promise<MergeResult> {
  const at = await assertWorktree(repo, wt);
  const res = await git([...IDENTITY, "merge", "--no-ff", "--no-edit", branch], at);
  if (res.code === 0) return { ok: true, conflicts: [], output: res.stdout };
  const conflicts = await git(["diff", "--name-only", "--diff-filter=U", ...RAW_DIFF], at);
  return {
    ok: false,
    conflicts: conflicts.stdout.trim().split("\n").filter(Boolean),
    output: `${res.stdout}\n${res.stderr}`.trim(),
  };
}

export async function isClean(cwd: GitCwd): Promise<boolean> {
  return (await gitOk(["status", "--porcelain"], cwd)) === "";
}

export async function uncommittedCount(cwd: GitCwd): Promise<number> {
  const out = await gitOk(["status", "--porcelain"], cwd);
  return out ? out.split("\n").length : 0;
}

/** Move a disposable worktree of `repo` to `to`, dropping its changes and untracked (non-ignored) files. */
export async function discardChanges(repo: string, wt: CheckoutRef, to = "HEAD"): Promise<void> {
  const at = await assertWorktree(repo, wt);
  await gitOk(["reset", "--hard", "-q", to], at);
  await gitOk(["clean", "-fdq"], at);
}

/** A worktree's state before a read-only step: its commit, uncommitted changes, untracked files. */
export interface Snapshot {
  head: string;
  /** `git stash create` of the uncommitted changes ("" when there are none); nothing is stashed. */
  changes: string;
  untracked: string[];
  /**
   * What the untracked files held (path → blob, written to the object store): `stash create`
   * leaves them out, so an edit to one would otherwise survive a restore. Very large files and
   * very many are left out (see SNAPSHOT_FILE_LIMIT).
   */
  untrackedBlobs?: Record<string, string>;
}

/** Untracked files bigger than this, or past this many, aren't saved in a snapshot. */
const SNAPSHOT_FILE_LIMIT = { bytes: 8 * 1024 * 1024, files: 2_000 };

/**
 * Untracked files' contents as blobs, byte for byte: no clean filter (LFS's would save a
 * pointer, and an agent's `.gitattributes` would pick which ones run).
 */
const HASH_AS_IS = ["hash-object", "--no-filters", "--stdin-paths"];

/** Save untracked files' contents as blobs; returns path → blob for those it saved. */
async function saveUntracked(at: Checkout, paths: string[]): Promise<Record<string, string>> {
  const files: string[] = [];
  for (const path of paths) {
    if (files.length >= SNAPSHOT_FILE_LIMIT.files) break;
    if (path.includes("\n")) continue; // can't go through --stdin-paths
    const info = await lstat(join(at.path, path)).catch(() => undefined);
    if (info?.isFile() && info.size <= SNAPSHOT_FILE_LIMIT.bytes) files.push(path);
  }
  if (!files.length) return {};
  const ids = (await gitOk([...HASH_AS_IS, "-w"], at, { input: `${files.join("\n")}\n` })).split("\n");
  return Object.fromEntries(files.map((f, i) => [f, ids[i]!]).filter(([, id]) => /^[0-9a-f]{40,64}$/.test(id!)));
}

/** Write blob `id` to `path` in a checkout, byte for byte (binary files too). */
function writeBlob(at: Checkout, id: string, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const target = join(at.path, path);
    mkdirSync(dirname(target), { recursive: true });
    const fd = openSync(target, "w");
    const command = gitCommand(["cat-file", "blob", id], at);
    const child = spawn("git", command.args, { cwd: at.path, env: command.env, stdio: ["ignore", fd, "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (err) => {
      closeSync(fd);
      reject(err);
    });
    child.on("close", (code) => {
      closeSync(fd);
      if (code === 0) resolve();
      else reject(new Error(`git cat-file blob ${id} failed: ${stderr.trim()}`));
    });
  });
}

/**
 * `git stash create` against a copy of the worktree's index: it refreshes the index, which
 * takes `index.lock` and fails (silently, exit 1) when the lock is held. On a copy, read-only
 * steps side by side in one worktree, an agent's own git, or yours never collide with it.
 */
async function stashCreate(at: Checkout): Promise<string> {
  const index = resolve(at.path, await gitOk(["rev-parse", "--git-path", "index"], at));
  const copy = `${index}.codeflow-${process.pid}-${randomBytes(4).toString("hex")}`;
  const copied = await copyFile(index, copy).then(() => true, () => false);
  const env = copied ? { env: { GIT_INDEX_FILE: copy } } : undefined;
  try {
    // Refreshed first: a file touched but unchanged makes `stash create` see a change, then none
    // once it refreshes, and exit 1 with nothing printed. (On the real index, the first call's
    // refresh hid that; a copy is stale every time.)
    if (copied) await git(["update-index", "-q", "--refresh"], at, env);
    return (await gitOk(["stash", "create"], at, env)).trim();
  } finally {
    if (copied) await Promise.all([rm(copy, { force: true }), rm(`${copy}.lock`, { force: true })]);
  }
}

/** gitOk, tried again for a few seconds while another git process holds a lock (an agent's, yours). */
async function gitOkWhenFree(args: string[], at: Checkout): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const res = await git(args, at);
    if (res.code === 0) return res.stdout.trim();
    if (attempt >= 5 || classifyGitFailure(res) !== "locked") throw new Error(gitError(args, res));
    await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
  }
}

async function uncommittedTree(at: Checkout): Promise<string> {
  const sha = await stashCreate(at);
  return sha ? (await gitOk(["rev-parse", `${sha}^{tree}`], at)).trim() : "";
}

const untrackedFiles = async (at: Checkout) => (await gitOk(["ls-files", "--others", "--exclude-standard", "-z"], at)).split("\0").filter(Boolean);

/**
 * The state of the worktree of `repo` at `cwd` (see Snapshot). Refused when its `.git` is broken
 * (see assertWorktree): an agent's own git there would act on another checkout.
 */
export async function snapshot(repo: string, cwd: string): Promise<Snapshot> {
  return withWorktreeLock(cwd, async () => {
    const at = await assertWorktree(repo, { path: cwd });
    const untracked = await untrackedFiles(at);
    return {
      head: await resolveCommit(at),
      changes: await stashCreate(at),
      untracked,
      untrackedBlobs: await saveUntracked(at, untracked),
    };
  });
}

/**
 * Put a worktree of `repo` back the way `snapshot` found it, undoing whatever a read-only step
 * did: commits, edits, new files. Returns what was undone (empty when nothing changed). Throws
 * a WorktreeMismatchError, undoing nothing, when the step broke the worktree's `.git` or moved it
 * to another branch (see assertWorktree).
 */
export async function restoreSnapshot(repo: string, wt: CheckoutRef, snap: Snapshot): Promise<string[]> {
  return compareSnapshot(repo, wt, snap, true);
}

/**
 * What changed in a worktree of `repo` since `snapshot`, in the same words as `restoreSnapshot`,
 * with all of it left in place (empty when nothing changed).
 */
export async function changedSince(repo: string, wt: CheckoutRef, snap: Snapshot): Promise<string[]> {
  return compareSnapshot(repo, wt, snap, false);
}

/** What changed since `snap`; with `undo`, each change is undone as it's found. */
function compareSnapshot(repo: string, wt: CheckoutRef, snap: Snapshot, undo: boolean): Promise<string[]> {
  const cwd = wt.path;
  return withWorktreeLock(cwd, async () => {
    // Only undoing changes the branch, so only then must it be the worktree's own.
    const at = await assertWorktree(repo, undo ? wt : { path: cwd });
    const found: string[] = [];
    const head = await resolveCommit(at);
    const changesNow = await uncommittedTree(at);
    const changesBefore = snap.changes ? (await gitOk(["rev-parse", `${snap.changes}^{tree}`], at)).trim() : "";
    if (head !== snap.head) found.push("commits");
    if (head !== snap.head || changesNow !== changesBefore) {
      if (head === snap.head) found.push("edits");
      if (undo) {
        await gitOkWhenFree(["reset", "--hard", "-q", snap.head], at);
        if (snap.changes) await gitOkWhenFree(["stash", "apply", "-q", snap.changes], at);
      }
    }
    const before = new Set(snap.untracked);
    const added = (await untrackedFiles(at)).filter((f) => !before.has(f));
    if (added.length) {
      found.push(`${added.length} new file${added.length === 1 ? "" : "s"}`);
      if (undo) for (let i = 0; i < added.length; i += 100) await gitOkWhenFree(["clean", "-fq", "--", ...added.slice(i, i + 100)], at);
    }
    // Untracked files that were there before: edited or deleted since, they get their contents back.
    const saved = Object.entries(snap.untrackedBlobs ?? {});
    if (saved.length) {
      const present = (await Promise.all(saved.map(async ([path]) => ((await lstat(join(at.path, path)).catch(() => undefined))?.isFile() ? path : undefined)))).filter(
        (p): p is string => !!p,
      );
      const now = present.length ? (await gitOk(HASH_AS_IS, at, { input: `${present.join("\n")}\n` })).split("\n") : [];
      const current = new Map(present.map((p, i) => [p, now[i]]));
      const changed = saved.filter(([path, id]) => current.get(path) !== id);
      for (const [path, id] of undo ? changed : []) {
        await rm(join(at.path, path), { recursive: true, force: true });
        await writeBlob(at, id, path);
      }
      if (changed.length) found.push(`${changed.length} untracked file${changed.length === 1 ? "" : "s"} ${undo ? "put back" : "changed"}`);
    }
    return found;
  });
}

/** A merge is in progress (conflicts being resolved): starting over would lose it. */
export async function isMerging(cwd: GitCwd): Promise<boolean> {
  return (await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], cwd)).code === 0;
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repo)).code === 0;
}

/** True when commit `a` is `b` or one of its ancestors. */
export async function isAncestor(cwd: GitCwd, a: string, b = "HEAD"): Promise<boolean> {
  return (await git(["merge-base", "--is-ancestor", a, b], cwd)).code === 0;
}

/** Put `paths` in a worktree of `repo` back to how they are in `ref` (deleting the ones `ref` doesn't have). */
export async function restorePaths(repo: string, wt: CheckoutRef, ref: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  const at = await assertWorktree(repo, wt);
  for (const path of paths) {
    if (await objectTypeAt(at, ref, path)) await gitOk(["checkout", ref, "--", path], at);
    else await git(["rm", "-q", "-f", "--ignore-unmatch", "--", path], at);
  }
}

/** A ref the user named (e.g. a branch to merge): must exist and can't be read as an option. */
export async function validRef(repo: string, ref: string): Promise<boolean> {
  return !!ref && !ref.startsWith("-") && (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repo)).code === 0;
}

export async function hasConflictMarkers(at: GitCwd): Promise<boolean> {
  const res = await git(["diff", "--check", ...RAW_DIFF], at);
  return /conflict marker/i.test(res.stdout + res.stderr);
}
