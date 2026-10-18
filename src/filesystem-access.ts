import type { IncomingMessage } from "node:http";
import type { Run, RunManager, RunSummary } from "./engine.js";
import type { Projects } from "./projects.js";
import { FilePolicyError, ProjectFilePolicies, policyIsRestrictive, type FilePolicySnapshot } from "./filesystem-policy.js";
import { readJson } from "./http.js";
import { repoRoot } from "./git.js";

/** Server boundary and current/pinned ownership resolution; low-level helpers use the same resolver. */
export class FilesystemAccess {
  private cache = new Map<string, FilePolicySnapshot>();
  private operations = new Set<IncomingMessage>();
  private activating = false;
  private failure?: unknown;
  constructor(readonly store: ProjectFilePolicies, private projects: Projects, private manager: RunManager) {
    store.onChange((next) => this.cache.set(next.projectId, next));
  }
  async all() { try { const policies = await Promise.all(this.projects.list().map(async (project) => { const policy = await this.store.get(project.id); this.cache.set(project.id, policy); return policy; })); this.failure = undefined; return policies; } catch (error) { this.failure = error; throw error; } }
  hasRestrictions() { return !!this.failure || [...this.cache.values()].some(policyIsRestrictive); }
  private projectIds(repo: string, run?: Run | RunSummary): string[] {
    const related = new Set([repo]); const owned = this.manager.list().filter((item) => item.repo === repo || item.worktrees.some((tree) => tree.path === repo));
    for (const item of owned) related.add(item.repo);
    return [...new Set([...this.projects.list().filter((project) => project.repos.some((repo) => related.has(repo))).map((project) => project.id), ...owned.flatMap((item) => item.project ? [item.project] : []), ...(run?.project ? [run.project] : [])])];
  }
  async forRepo(repo: string, run?: Run | RunSummary) { const policies = await Promise.all(this.projectIds(repo, run).map(async (id) => { const policy = await this.store.get(id); this.cache.set(id, policy); return policy; })); return [...policies, ...((run as Run & { filePolicies?: FilePolicySnapshot[] } | undefined)?.filePolicies ?? [])]; }
  async execution(repo: string, run?: Run) { if (this.activating) throw new FilePolicyError("Filesystem policy is being applied; execution preparation is paused", 409); return [...await this.all(), ...await this.forRepo(repo, run)]; }
  restrictedRun(run: Run | RunSummary): boolean { return this.projectIds(run.repo, run).some((id) => { const policy = this.cache.get(id); return !!policy && policyIsRestrictive(policy); }) || !!(run as Run & { filePolicies?: FilePolicySnapshot[] }).filePolicies?.some(policyIsRestrictive); }
  list() { return this.manager.list().filter((run) => !this.restrictedRun(run)); }
  page(input: Parameters<RunManager["page"]>[0] = {}) {
    return this.manager.page({ ...input, ...(this.hasRestrictions() ? { predicate: (run) => !this.restrictedRun(run) && (input.predicate?.(run) ?? true) } : {}) });
  }
  end(req: IncomingMessage) { this.operations.delete(req); }
  async sharedGate(req: IncomingMessage) { if (this.activating) throw new FilePolicyError("Filesystem policy is being applied; retry after it finishes", 409); this.operations.add(req); await this.all(); }
  async update(projectId: string, input: { revision: unknown; read: unknown; write: unknown }, activate: (commit: () => Promise<void>, next: FilePolicySnapshot) => Promise<void>) {
    if (this.activating || this.operations.size) throw new FilePolicyError("Wait for active application operations to finish before changing filesystem policy", 409);
    this.activating = true;
    try { return await this.store.set(projectId, input, async (commit, next) => activate(commit, next)); }
    finally { this.activating = false; }
  }
  /** Register before awaiting body/policy reads. Policy activation cannot race an in-flight command request. */
  async ownerGate(req: IncomingMessage, url: URL, parts: string[]) {
    if (parts[1] === "projects" && parts[3] === "filesystem-policy") return;
    if (this.activating) throw new FilePolicyError("Filesystem policy is being applied; retry after it finishes", 409);
    this.operations.add(req);
    const all = await this.all(); const globallyRestricted = all.some(policyIsRestrictive);
    const body = ["POST", "PUT", "PATCH"].includes(req.method ?? "") && req.headers["content-type"]?.startsWith("application/json") ? await readJson(req) : {};
    const requested = typeof body.repo === "string" ? body.repo : url.searchParams.get("repo");
    const selected = requested?.startsWith("/") ? await repoRoot(requested).catch(() => requested) : requested;
    const run = parts[1] === "runs" && parts[2] ? this.manager.get(parts[2]) : undefined;
    const policyProject = parts[1] === "projects" && parts[2] ? this.cache.get(parts[2]) : typeof body.project === "string" ? this.cache.get(body.project) : undefined;
    const targetRestricted = !!run && this.restrictedRun(run) || !!policyProject && policyIsRestrictive(policyProject) || !!selected && (await this.forRepo(selected)).some(policyIsRestrictive);
    const fileApi = parts[1] === "file" && req.method === "GET" || parts[1] === "workspace" && parts[2] === "file" && ["GET", "POST"].includes(req.method ?? "");
    const safeSearch = req.method === "GET" && (["tree", "search"].includes(parts[1] ?? "") || parts[1] === "workspace" && parts[2] === "search" && url.searchParams.get("mode") !== "semantic");
    const filteredDiff = req.method === "GET" && parts[1] === "runs" && parts[3] === "diff";
    if (targetRestricted && !fileApi && !safeSearch && !filteredDiff) throw new FilePolicyError("This project's filesystem policy blocks raw history, configuration and operations that cannot enforce its paths", req.method === "GET" ? 403 : 409);
    if (globallyRestricted) {
      const globalPrivate = ["fs", "notes", "memory", "stats", "automations", "deferred-runs", "coordination", "coordinated-changes", "notifications", "maintenance", "diagnostics", "shells", "serve", "preview", "snapshot", "disk", "cleanup", "models", "doctor", "approvals", "team-capabilities", "team-evaluations", "team-rollout"].includes(parts[1] ?? "");
      const execution = req.method !== "GET" && (["runs", "readiness", "verification", "compare", "sweeps", "automations", "deferred-runs", "coordination", "coordinated-changes", "remote-workers", "code-hosts"].includes(parts[1] ?? "") || parts[1] === "workspace" && !fileApi);
      if (globalPrivate || execution || parts[1] === "workspace" && ["references", "dependencies"].includes(parts[2] ?? "") || parts[1] === "workspace" && parts[2] === "search" && url.searchParams.get("mode") === "semantic") throw new FilePolicyError("Custom filesystem restrictions pause app-managed execution and unscoped private data access globally because current backends share host authority", req.method === "GET" ? 403 : 409);
    }
  }
}
