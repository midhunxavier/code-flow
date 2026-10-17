import type { Run } from "./engine.js";
import { git, isAncestor, resolveCommit } from "./git.js";
import { memoryStore, type MemoryAuthority, type MemoryEntry, type MemoryQuery, type MemoryRef, type MemorySelection, type MemoryStore } from "./memory.js";
import type { Projects } from "./projects.js";

export interface TeamMemoryOptions {
  /** Supplying the live registry rechecks membership when projects are moved/deleted. */
  projects?: Pick<Projects, "get">;
  store?: MemoryStore;
  branch?: string;
  head?: string;
  query?: string;
  maxEntries?: number;
  maxChars?: number;
}

export interface ProjectMemoryFinding {
  title: string;
  body: string;
  paths?: string[];
  evidenceRefs?: string[];
  /** Validated memory references, not source/trust claims supplied by the model. */
  derivedFrom?: MemoryRef[];
}

type MemoryRun = Run & { memoryManifest?: MemorySelection["manifest"] };
const empty = (): MemorySelection => ({ entries: [], manifest: { included: [], omitted: [] } });

/** Execution permission and content provenance are separate: trusted setup can read hostile text. */
export function memoryAuthorityForRun(run: Pick<Run, "id" | "repo" | "project" | "lockdown" | "source" | "inheritedSourceTrust">, memberId?: string): MemoryAuthority {
  const sourceTrust = run.lockdown || run.source?.trusted === false || run.source?.untrustedText || run.inheritedSourceTrust === "untrusted"
    ? "untrusted"
    : run.source && run.source.trusted !== true || run.inheritedSourceTrust === "unknown" ? "unknown" : "trusted";
  return { kind: "run", runId: run.id, repo: run.repo, projectId: run.project, memberId, lockedDown: !!run.lockdown, sourceTrust };
}

/** Read project entries using the exact run/project/repository and verified Git applicability. */
export async function projectMemoryForRun(run: MemoryRun, memberId?: string, taskId?: string, paths?: string[], options: TeamMemoryOptions = {}): Promise<MemorySelection> {
  if (!memberOfProject(run, options)) return empty();
  return (options.store ?? memoryStore).retrieve(await projectQuery(run, memberId, taskId, paths, options), memoryAuthorityForRun(run, memberId));
}

/** Replay uses only references actually selected for the recorded turn; bodies can be erased. */
export async function projectMemoryFromManifest(run: MemoryRun, manifest: MemorySelection["manifest"], memberId?: string, taskId?: string, paths?: string[], options: TeamMemoryOptions = {}): Promise<MemorySelection> {
  if (!memberOfProject(run, options)) return { entries: [], manifest: { included: [], omitted: [...manifest.omitted, ...manifest.included.map((ref) => ({ ...ref, reason: "project membership changed" }))] } };
  return (options.store ?? memoryStore).resolveSelection(await projectQuery(run, memberId, taskId, paths, options), manifest, memoryAuthorityForRun(run, memberId));
}

async function projectQuery(run: MemoryRun, memberId: string | undefined, taskId: string | undefined, paths: string[] | undefined, options: TeamMemoryOptions): Promise<MemoryQuery> {
  const store = options.store ?? memoryStore;
  const authority = memoryAuthorityForRun(run, memberId);
  const head = options.head ?? run.baseRef;
  const branch = options.branch ?? await runBaseBranch(run);
  const entries = await store.list({ repo: run.repo, projectId: run.project, scope: "project" }, authority);
  const commits = [...new Set(entries.flatMap((entry) => entry.applicability.kind === "branch" && entry.applicability.branch === branch && entry.applicability.commit ? [entry.applicability.commit] : []))].slice(0, 128);
  const allowedCommits: string[] = [];
  for (const commit of commits) if (commit === head || await isAncestor(run.repo, commit, head)) allowedCommits.push(commit);
  return {
    repo: run.repo, projectId: run.project, scope: "project", runId: run.id, memberId,
    branch, commit: head, allowedCommits, paths,
    query: options.query ?? `${run.task}\n${taskId ?? ""}`, maxEntries: options.maxEntries ?? 8, maxChars: options.maxChars ?? 8_000,
  };
}

/**
 * Findings on a result branch stay proposals. Checks on an unmerged implementation do not
 * make it a repository convention. Publication is an authenticated, exact-revision action.
 */
export async function proposeProjectMemories(run: MemoryRun, findings: ProjectMemoryFinding[], taskId: string, head: string, memberId?: string, options: TeamMemoryOptions = {}): Promise<MemoryEntry[]> {
  if (!memberOfProject(run, options) || run.learn === false || !findings.length) return [];
  if (!/^[0-9a-f]{40,64}$/i.test(head)) throw new Error("Memory findings require a full result commit SHA");
  const store = options.store ?? memoryStore;
  const authority = memoryAuthorityForRun(run, memberId);
  const branch = options.branch ?? run.worktrees.find((tree) => tree.name === "integrated")?.branch ?? run.worktrees.find((tree) => tree.name === "integration")?.branch ?? `${run.branchPrefix}/integrated`;
  // Preserve the union of knowledge actually shown to this run. A summarizer's omission of
  // source IDs must never erase untrusted origins. No memory bodies go into the run journal.
  const selected = run.memoryManifest?.included.map(({ id, revision }) => ({ id, revision })) ?? [];
  const created: MemoryEntry[] = [];
  for (const [index, finding] of findings.slice(0, 32).entries()) {
    const refs = [...new Map([...selected, ...(finding.derivedFrom ?? [])].map((ref) => [`${ref.id}@${ref.revision}`, ref])).values()];
    created.push(await store.propose({
      scope: "project", repo: run.repo, projectId: run.project, runId: run.id, memberId,
      title: finding.title, body: finding.body, paths: finding.paths,
      applicability: { kind: "branch", branch, commit: head }, derivedFrom: refs,
      sourceRefs: [`run:${run.id}`, `task:${taskId}`, `commit:${head}`, ...(finding.evidenceRefs ?? [])],
      operationId: `${run.id}:${taskId}:${head}:${index}`,
    }, authority));
  }
  return created;
}

function memberOfProject(run: Pick<Run, "project" | "repo">, options: TeamMemoryOptions): boolean {
  if (!run.project) return false;
  if (!options.projects) return true;
  return options.projects.get(run.project)?.repos.includes(run.repo) ?? false;
}

async function runBaseBranch(run: Pick<Run, "repo" | "baseLabel" | "baseRef">): Promise<string | undefined> {
  if (run.baseLabel && run.baseLabel !== "HEAD" && !/^[0-9a-f]{40,64}$/i.test(run.baseLabel)) return run.baseLabel.replace(/^refs\/heads\//, "");
  // HEAD may have moved since the run started. Do not attach today's branch to old evidence.
  if (await resolveCommit(run.repo).catch(() => undefined) !== run.baseRef) return undefined;
  const result = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], run.repo);
  return result.code === 0 ? result.stdout.trim() || undefined : undefined;
}
