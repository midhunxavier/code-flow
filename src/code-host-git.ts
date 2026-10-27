import { mkdtemp, chmod, rm, readdir, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { git, resolveCommit, type GitOptions, type GitResult } from "./git.js";
import { CODE_HOST_IMPORTS, CODE_HOST_PROVENANCE, trustedCodeHostCommits, removeCodeHostImport } from "./code-host-imports.js";
import type { CodeHostSession } from "./integrations.js";

export interface CodeRefs { head: string; target: string; sourceUrl: string; targetUrl: string; sourceRef: string; targetRef: string }
export interface ImportedCode { head: string; target: string; base: string; branch: string; into: string; diff: string; truncated: boolean }
/** Dependency injection is used only by explicit fixture tests; production has no transport toggle. */
export type CodeHostGitCommand = (args: string[], cwd: string, options: GitOptions) => Promise<GitResult>;
class CodeHostStagingError extends Error {}
type StagingFilesystem = { readdir: (path: string) => Promise<string[]>; lstat: (path: string) => Promise<Pick<Stats, "isSymbolicLink" | "isDirectory" | "size">> };
/** Inspect the current private staging tree; injectable filesystem operations support race regressions. */
export async function checkCodeHostStagingBudget(path: string, filesystem: StagingFilesystem = { readdir, lstat }) {
  let bytes = 0, files = 0;
  const visit = async (dir: string) => {
    const names = await filesystem.readdir(dir).catch(error => {
      if (dir !== path && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const name of names) {
      const child = join(dir, name), info = await filesystem.lstat(child).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      // Git atomically replaces lock files and temporary object directories while fetching.
      if (!info) continue;
      if (info.isSymbolicLink()) throw new CodeHostStagingError("Unsafe staging path");
      if (info.isDirectory()) await visit(child);
      else { bytes += info.size; if (++files > 20_000 || bytes > 256 * 1024 * 1024) throw new CodeHostStagingError("Code fetch exceeds storage limits (256 MiB or 20,000 files)"); }
    }
  };
  await visit(path);
}
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const OPTIONS = ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "http.sslVerify=true", "-c", "http.followRedirects=false", "-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=never", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "fetch.fsckObjects=true", "-c", "transfer.fsckObjects=true"];
const isolatedEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.keys(process.env).filter((key) => /^GIT_|^GCM_|^SSH_ASKPASS$|^GIT_ASKPASS$/.test(key)).map((key) => [key, undefined]));
export function codeHostRemote(session: CodeHostSession, path: string): string {
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(path) || path.split("/").some((part) => part === "." || part === "..")) throw new Error("Code host returned an unsafe repository path");
  return new URL(`${path}.git`, session.config.gitBaseUrl).href;
}
export class CodeHostGit {
  constructor(private readonly command: CodeHostGitCommand = git) {}
  private async checked(args: string[], cwd: string, options: GitOptions = {}) {
    const result = await this.command([...OPTIONS, ...args], cwd, { timeoutMs: 120_000, ...options, env: { ...isolatedEnv(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...options.env } });
    if (result.code) throw new Error(result.aborted ? `Code host Git action cancelled${args[0] === "push" ? "; inspect any attempted push before retrying" : ""}` : "Code host Git action failed or timed out; check access, size limits and exact remote state before retrying");
    return result.stdout.trim();
  }
  private async staging<T>(session: CodeHostSession, signal: AbortSignal | undefined, action: (path: string, run: (args: string[], remote?: string, input?: string) => Promise<string>, checkReady: () => Promise<void>) => Promise<T>): Promise<T> {
    const path = await mkdtemp(join(tmpdir(), "codeflow-code-host-")); await chmod(path, 0o700);
    const abort = new AbortController(), linked = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    let checking = false;
    const checkBudget = () => checkCodeHostStagingBudget(path);
    const monitor = setInterval(() => { if (checking) return; checking = true; void checkBudget().catch(error => abort.abort(error)).finally(() => { checking = false; }); }, 250); monitor.unref();
    try {
      await this.checked(["init", "--bare", "-q", path], path, { signal: linked });
      const run = (args: string[], remote?: string, input?: string) => this.checked(args, path, { signal: linked, input, ...(remote ? { env: session.gitEnvironment(remote) } : {}) });
      const checkReady = async () => { await checkBudget(); linked.throwIfAborted(); };
      const result = await action(path, run, checkReady); await checkReady(); return result;
    } catch (error) {
      // Retain an internal monitor failure instead of reporting generic cancellation;
      // a caller-initiated cancellation keeps its original path.
      if (linked.aborted && linked.reason instanceof Error && !signal?.aborted) throw linked.reason;
      throw error;
    } finally { clearInterval(monitor); await rm(path, { recursive: true, force: true }); }
  }
  async fetch(repo: string, session: CodeHostSession, refs: CodeRefs, signal?: AbortSignal, authorize?: () => void): Promise<ImportedCode> {
    if (![refs.head, refs.target].every((value) => SHA.test(value))) throw new Error("Code host returned invalid commit identities");
    const trusted = await trustedCodeHostCommits(repo);
    const id = randomBytes(20).toString("hex"), branch = `${CODE_HOST_IMPORTS}${id}/source`, into = `${CODE_HOST_IMPORTS}${id}/target`;
    let attemptedImport = false;
    try { return await this.staging(session, signal, async (path, run, checkReady) => {
      for (const ref of [refs.sourceRef, refs.targetRef]) await run(["check-ref-format", ref]);
      await run(["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", refs.sourceUrl, `${refs.sourceRef}:refs/heads/source`], refs.sourceUrl);
      await run(["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", refs.targetUrl, `${refs.targetRef}:refs/heads/target`], refs.targetUrl);
      if (await run(["rev-parse", "source^{commit}"]) !== refs.head || await run(["rev-parse", "target^{commit}"]) !== refs.target) throw new Error("The remote source or target advanced. Load a fresh preview before fetching code.");
      const base = await run(["merge-base", refs.head, refs.target]); if (!SHA.test(base)) throw new Error("The source and target have no verified common history");
      if (trusted.length) await run(["-c", "protocol.file.allow=always", "fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--stdin", repo], undefined, trusted.map((head, index) => `${head}:refs/codeflow/trusted/${index}\n`).join(""));
      const untrusted = (await run(["rev-list", "--max-count=1001", "--stdin"], undefined, `${refs.head}\n${refs.target}\n${trusted.map(head => `^${head}\n`).join("")}`)).split("\n").filter(Boolean);
      if (untrusted.length > 1000 || untrusted.some(head => !SHA.test(head))) throw new Error("Code host source exceeds the 1,000-commit import limit");
      await run(["update-ref", "refs/heads/import-base", trusted[0] ?? base]);
      // No credentials enter the user's repository, its config, hooks, logs or agent environment.
      // The periodic monitor can miss a fast fetch. Check before importing objects.
      await checkReady();
      authorize?.(); attemptedImport = true;
      await this.checked(["-c", "protocol.file.allow=always", "fetch", "--atomic", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", path, `refs/heads/source:${branch}`, `refs/heads/target:${into}`, ...untrusted.map(head => `refs/heads/import-base:${CODE_HOST_PROVENANCE}${head}`)], repo, { signal });
      const diff = await this.checked(["diff", "--no-ext-diff", "--no-textconv", "--no-color", `${base}..${refs.head}`, "--"], repo, { signal });
      return { head: refs.head, target: refs.target, base, branch, into, diff: diff.slice(0, 250_000), truncated: diff.length > 250_000 };
    }); } catch (error) {
      // staging() can still reject after the callback (budget/cancellation), so cleanup lives outside it.
      if (attemptedImport) await removeCodeHostImport(repo, { branch, into });
      throw error;
    }
  }
  /** Sends a descendant of an exact observed remote commit; never an arbitrary force push. */
  async push(repo: string, session: CodeHostSession, input: { url: string; ref: string; expected: string; commit: string; beforeEffect?: () => void }, signal?: AbortSignal) {
    if (!SHA.test(input.commit) || input.expected !== "" && !SHA.test(input.expected) || !input.ref.startsWith("refs/heads/")) throw new Error("Invalid pinned push");
    return this.staging(session, signal, async (_path, run, checkReady) => {
      await run(["check-ref-format", input.ref]);
      await run(["-c", "protocol.file.allow=always", "fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", repo, input.commit]);
      if (input.expected) await run(["merge-base", "--is-ancestor", input.expected, input.commit]);
      // The lease is an atomic server ref precondition, even if the target changes after preview.
      await checkReady();
      input.beforeEffect?.();
      await run(["push", "--porcelain", `--force-with-lease=${input.ref}:${input.expected}`, input.url, `${input.commit}:${input.ref}`], input.url);
      const current = await run(["ls-remote", "--refs", input.url, input.ref], input.url);
      if (current.split(/\s/)[0] !== input.commit) throw new Error("Push response was received, but the remote ref no longer matches; its outcome requires inspection");
      return { commit: input.commit };
    });
  }
  async mergeCommit(repo: string, input: { target: string; source: string; tree: string }, signal?: AbortSignal) {
    if (![input.target, input.source, input.tree].every((value) => SHA.test(value))) throw new Error("Invalid validated merge objects");
    const commit = await this.checked(["-c", "user.name=code-flow", "-c", "user.email=code-flow@local.invalid", "commit-tree", input.tree, "-p", input.target, "-p", input.source, "-m", "Merge explicitly reviewed code host pull request"], repo, { signal });
    if (!SHA.test(commit) || await resolveCommit(repo, commit) !== commit) throw new Error("Cannot record the pinned merge candidate"); return commit;
  }
}
