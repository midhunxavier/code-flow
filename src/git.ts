import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { appendFile, copyFile, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { envNumber, timerMs, WORKTREE_DIR } from "./config.js";
import { childEnv } from "./env.js";
import { logWarn } from "./log.js";

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
 * The arguments and environment for code-flow's own git in `cwd`:
 * - git looks for the repository in `cwd` and nowhere above it (GIT_CEILING_DIRECTORIES). A
 *   worktree lives inside your checkout, and once an agent deletes its `.git`, git run there
 *   would find your checkout instead: a `reset --hard` meant for the worktree would reset yours.
 * - no fsmonitor and no hooks, whatever a config file says. An agent can point a worktree's
 *   `.git` at a git folder of its own making, whose config would otherwise have code-flow run
 *   the agent's commands outside its sandbox. Your hooks still run where you'd expect them to:
 *   a merge into your checkout and a push (Git LFS uploads its files in pre-push).
 */
function gitCommand(args: string[], cwd: string, opts: GitOptions = {}): { args: string[]; env: NodeJS.ProcessEnv } {
  const own = ["-c", "core.fsmonitor=false", ...(opts.hooks ? [] : ["-c", "core.hooksPath=/dev/null"])];
  const ceiling = opts.discover ? {} : { GIT_CEILING_DIRECTORIES: dirname(realPathSync(cwd)) };
  return { args: [...own, ...args], env: gitEnv({ ...ceiling, ...opts.env }) };
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
export function git(args: string[], cwd: string, opts: GitOptions = {}): Promise<GitResult> {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const command = gitCommand(args, cwd, opts);
    // Its own process group, so a timeout also stops the hooks (and their children) git started.
    const child = spawn("git", command.args, { cwd, env: command.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
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
  return gitOk(["rev-parse", "--show-toplevel"], path, { discover: true });
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

/** A checkout to change: its folder, and the branch it must be on (none for a detached one). */
export type CheckoutRef = { path: string; branch?: string };

/** A checkout that isn't the one code-flow means to change (see assertWorktree). */
export class WorktreeMismatchError extends Error {}

/**
 * Before code-flow changes a checkout of `repo` (resets it, cleans it, puts a stash back, commits,
 * merges, removes it): make sure git will act on that checkout and nothing else. An agent can
 * delete or rewrite the worktree's `.git` (it's a file in the worktree), and git would then act
 * on your checkout above it, or on a repository of the agent's making. Throws, saying what's
 * wrong, instead. What it checks:
 * - `.git` is the file git wrote, pointing at the worktree's folder in `repo`'s git folder, which
 *   points back at it (an agent can't write there). For your main checkout, `.git` is `repo`'s
 *   git folder itself.
 * - git sees the checkout as its own top folder.
 * - with `wt.branch`, HEAD is that branch: a reset or commit on another one would change it.
 */
export async function assertWorktree(repo: string, wt: CheckoutRef): Promise<void> {
  const problem = await worktreeProblem(repo, wt);
  if (problem) {
    throw new WorktreeMismatchError(
      `${wt.path} isn't the checkout code-flow expects (${problem}), so code-flow didn't run git there: it could have changed another checkout or branch, such as yours. Nothing was changed.`,
    );
  }
}

async function worktreeProblem(repo: string, wt: CheckoutRef): Promise<string | undefined> {
  const common = await realPath(resolve(repo, await gitOk(["rev-parse", "--git-common-dir"], repo)));
  const path = await realPath(wt.path);
  const dotGit = join(path, ".git");
  const info = await lstat(dotGit).catch(() => undefined);
  if (!info) return "its .git is missing";
  let gitDir: string;
  if (info.isDirectory()) gitDir = await realPath(dotGit);
  else if (info.isFile()) {
    const named = /^gitdir: *(.+?)\s*$/m.exec(await readFile(dotGit, "utf8").catch(() => ""))?.[1];
    if (!named) return "its .git doesn't name a git folder";
    gitDir = await realPath(resolve(path, named));
  } else return `its .git is a ${info.isSymbolicLink() ? "symbolic link" : "special file"}`;

  if (gitDir === common) {
    const main = await mainWorktree(repo);
    if (!main || (await realPath(main)) !== path) return `its .git points to the git folder of ${main ?? repo} itself`;
  } else if (dirname(gitDir) === join(common, "worktrees")) {
    const back = (await readFile(join(gitDir, "gitdir"), "utf8").catch(() => "")).trim();
    if (!back) return `its .git points to ${gitDir}, which isn't there any more`;
    if ((await realPath(resolve(gitDir, back))) !== dotGit) return `its .git points to the git folder of another worktree (${gitDir})`;
  } else return `its .git points to ${gitDir}, which isn't one of ${repo}'s worktrees`;

  const top = await git(["rev-parse", "--show-toplevel"], path);
  if (top.code !== 0) return `git can't read it: ${gitError(["rev-parse"], top)}`;
  if ((await realPath(top.stdout.trim())) !== path) return `git sees ${top.stdout.trim()} as its top folder`;
  if (wt.branch) {
    const head = (await git(["symbolic-ref", "-q", "HEAD"], path)).stdout.trim();
    if (head !== `refs/heads/${wt.branch}`) return head ? `it's on ${head.replace(/^refs\/heads\//, "")}, not ${wt.branch}` : `its HEAD is detached, not on ${wt.branch}`;
  }
  return undefined;
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

/**
 * Stage and commit everything in a worktree of `repo`, except files that must not leave this
 * machine (`unstageSecrets`; `onWarning` names them). Returns the new commit, or null if clean.
 */
export async function commitAll(repo: string, wt: Worktree, message: string, onWarning?: (text: string) => void): Promise<string | null> {
  await assertWorktree(repo, wt);
  await gitOk(["add", "-A"], wt.path);
  await unstageSecrets(wt.path, onWarning);
  const staged = await git(["diff", "--cached", "--quiet"], wt.path);
  const merging = (await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], wt.path)).code === 0;
  if (staged.code === 0 && !merging) return null;
  await gitOk([...IDENTITY, "commit", "--no-verify", "-m", message], wt.path);
  return resolveCommit(wt.path);
}

/** In a worktree's git dir: the files code-flow copied in from your checkout (repo-config `copy`), NUL-separated. */
export const COPIED_FILES = "codeflow-copied";
/** Names of files that hold secrets, wherever they are: `.env`, `.env.*`, keys. */
const SECRET_NAME = /^(?:\.env(?:\..+)?|.+\.pem|id_rsa.*|id_ed25519.*)$/;
/** Templates of `.env` that repositories commit on purpose. */
const SECRET_TEMPLATE = /^\.env\.(?:example|sample|template)$/;

/**
 * Take back out of the index what `add -A` must not commit: files code-flow copied into this
 * worktree (`.env`…) and new files named like secrets. git ignores them, but an agent can edit
 * .gitignore or `git add -f` one, and the commit would then carry it to a pull request (a PR
 * follow-through pushes unattended). The file stays in the worktree; files the repository already
 * tracks are left alone unless code-flow copied them.
 */
async function unstageSecrets(cwd: string, onWarning?: (text: string) => void): Promise<void> {
  const staged = await git(["diff", "--cached", "--name-status", "--no-renames", "-z"], cwd);
  if (staged.code !== 0 || !staged.stdout) return;
  const record = (await git(["rev-parse", "--git-path", COPIED_FILES], cwd)).stdout.trim();
  const copied = new Set(record ? (await readFile(resolve(cwd, record), "utf8").catch(() => "")).split("\0").filter(Boolean) : []);
  const tokens = staged.stdout.split("\0");
  const drop: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const [status, path] = [tokens[i]!, tokens[i + 1]!];
    const name = path.slice(path.lastIndexOf("/") + 1);
    const secret = status === "A" && SECRET_NAME.test(name) && !SECRET_TEMPLATE.test(name);
    if ((copied.has(path) && status !== "D") || secret) drop.push(path);
  }
  if (!drop.length) return;
  await gitOk(["reset", "-q", "--", ...drop], cwd, { env: { GIT_LITERAL_PATHSPECS: "1" } });
  const text = `Left ${drop.join(", ")} out of the commit: ${drop.length === 1 ? "it was" : "they were"} copied in from your checkout or ${drop.length === 1 ? "is" : "are"} named like a secret. Commit it yourself if it belongs in the repository.`;
  logWarn(text, { worktree: cwd });
  onWarning?.(text);
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

export async function mergeBranch(repo: string, wt: Worktree, branch: string): Promise<MergeResult> {
  await assertWorktree(repo, wt);
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

/** Move a disposable worktree of `repo` to `to`, dropping its changes and untracked (non-ignored) files. */
export async function discardChanges(repo: string, wt: CheckoutRef, to = "HEAD"): Promise<void> {
  await assertWorktree(repo, wt);
  await gitOk(["reset", "--hard", "-q", to], wt.path);
  await gitOk(["clean", "-fdq"], wt.path);
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

/** Save untracked files' contents as blobs; returns path → blob for those it saved. */
async function saveUntracked(cwd: string, paths: string[]): Promise<Record<string, string>> {
  const files: string[] = [];
  for (const path of paths) {
    if (files.length >= SNAPSHOT_FILE_LIMIT.files) break;
    if (path.includes("\n")) continue; // can't go through --stdin-paths
    const info = await lstat(join(cwd, path)).catch(() => undefined);
    if (info?.isFile() && info.size <= SNAPSHOT_FILE_LIMIT.bytes) files.push(path);
  }
  if (!files.length) return {};
  const ids = (await gitOk(["hash-object", "-w", "--stdin-paths"], cwd, { input: `${files.join("\n")}\n` })).split("\n");
  return Object.fromEntries(files.map((f, i) => [f, ids[i]!]).filter(([, id]) => /^[0-9a-f]{40,64}$/.test(id!)));
}

/** Write blob `id` to `path` in `cwd`, byte for byte (binary files too). */
function writeBlob(cwd: string, id: string, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const target = join(cwd, path);
    mkdirSync(dirname(target), { recursive: true });
    const fd = openSync(target, "w");
    const command = gitCommand(["cat-file", "blob", id], cwd);
    const child = spawn("git", command.args, { cwd, env: command.env, stdio: ["ignore", fd, "pipe"] });
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

/**
 * The state of the worktree of `repo` at `cwd` (see Snapshot). Refused when its `.git` is broken
 * (see assertWorktree): an agent's own git there would act on another checkout.
 */
export async function snapshot(repo: string, cwd: string): Promise<Snapshot> {
  return withWorktreeLock(cwd, async () => {
    await assertWorktree(repo, { path: cwd });
    const untracked = await untrackedFiles(cwd);
    return {
      head: await resolveCommit(cwd),
      changes: await stashCreate(cwd),
      untracked,
      untrackedBlobs: await saveUntracked(cwd, untracked),
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
    await assertWorktree(repo, undo ? wt : { path: cwd });
    const found: string[] = [];
    const head = await resolveCommit(cwd);
    const changesNow = await uncommittedTree(cwd);
    const changesBefore = snap.changes ? (await gitOk(["rev-parse", `${snap.changes}^{tree}`], cwd)).trim() : "";
    if (head !== snap.head) found.push("commits");
    if (head !== snap.head || changesNow !== changesBefore) {
      if (head === snap.head) found.push("edits");
      if (undo) {
        await gitOkWhenFree(["reset", "--hard", "-q", snap.head], cwd);
        if (snap.changes) await gitOkWhenFree(["stash", "apply", "-q", snap.changes], cwd);
      }
    }
    const before = new Set(snap.untracked);
    const added = (await untrackedFiles(cwd)).filter((f) => !before.has(f));
    if (added.length) {
      found.push(`${added.length} new file${added.length === 1 ? "" : "s"}`);
      if (undo) for (let i = 0; i < added.length; i += 100) await gitOkWhenFree(["clean", "-fq", "--", ...added.slice(i, i + 100)], cwd);
    }
    // Untracked files that were there before: edited or deleted since, they get their contents back.
    const saved = Object.entries(snap.untrackedBlobs ?? {});
    if (saved.length) {
      const present = (await Promise.all(saved.map(async ([path]) => ((await lstat(join(cwd, path)).catch(() => undefined))?.isFile() ? path : undefined)))).filter(
        (p): p is string => !!p,
      );
      const now = present.length ? (await gitOk(["hash-object", "--stdin-paths"], cwd, { input: `${present.join("\n")}\n` })).split("\n") : [];
      const current = new Map(present.map((p, i) => [p, now[i]]));
      const changed = saved.filter(([path, id]) => current.get(path) !== id);
      for (const [path, id] of undo ? changed : []) {
        await rm(join(cwd, path), { recursive: true, force: true });
        await writeBlob(cwd, id, path);
      }
      if (changed.length) found.push(`${changed.length} untracked file${changed.length === 1 ? "" : "s"} ${undo ? "put back" : "changed"}`);
    }
    return found;
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

/** Put `paths` in a worktree of `repo` back to how they are in `ref` (deleting the ones `ref` doesn't have). */
export async function restorePaths(repo: string, wt: CheckoutRef, ref: string, paths: string[]): Promise<void> {
  const cwd = wt.path;
  if (paths.length) await assertWorktree(repo, wt);
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
