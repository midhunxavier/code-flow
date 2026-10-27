import type { IncomingMessage } from "node:http";
import type { Run, RunManager, RunSummary } from "./engine.js";
import type { Projects } from "./projects.js";
import { FilePolicyError, ProjectFilePolicies, policyIsRestrictive, type FilePolicySnapshot } from "./filesystem-policy.js";
import { readJson } from "./http.js";
import { repoRoot } from "./git.js";

/**
 * Under any custom restriction every top-level owner route (`/api/<segment>`, and its /api/v1 alias) is classified.
 * Private routes refuse every method, execution routes refuse all but GET, and open routes stay reachable because they
 * enforce paths, filter restricted results, report an unavailable state or refuse on their own. A segment in none of
 * these lists is refused like a private one, so a new or misspelled route cannot slip past the pause. A route that runs
 * a host CLI even to read (provider discovery, `gh` issue and pull-request listings) is private: that process has the
 * host's authority in whatever repository it lists, which no path rule can confine.
 */
export const RESTRICTED_PRIVATE_ROUTES = ["ml", "docs-help", "experience", "journeys", "fs", "notes", "stats", "automations", "deferred-runs", "coordinated-changes", "project-teams", "notifications", "maintenance", "diagnostics", "shell", "serve", "preview", "snapshot", "disk", "cleanup", "models", "model-catalog", "doctor", "github", "approvals", "team-capabilities", "team-evaluations", "team-rollout"];
export const RESTRICTED_EXECUTION_ROUTES = ["acp-connections", "runs", "readiness", "verification", "compare", "sweeps", "automations", "deferred-runs", "coordinated-changes", "project-teams", "remote-workers", "code-hosts", "improve-prompt", "team-link"];
export const RESTRICTION_OPEN_ROUTES = ["accounts", "agents", "branches", "browser", "check", "events", "extensions", "file", "health", "host-execution", "integration-connections", "integrations", "patterns", "projects", "remote", "repo-config", "search", "ssh-hosts", "ssh-runtime", "stream", "team", "team-host-runtime", "team-templates", "team-terminals", "templates", "tree", "v1", "workspace", "workspace-projects"];

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
  /** The projects whose saved policy restricts file access: owner metadata, like the policies themselves. */
  restrictedProjects() { return this.projects.list().filter((project) => { const policy = this.cache.get(project.id); return !!policy && policyIsRestrictive(policy); }).map(({ id, name }) => ({ id, name })); }
  /** Why owner work is paused, in words the app can show as they are: which project, what pauses, where to review it. */
  pauseMessage() {
    const restricted = this.restrictedProjects().map((project) => `“${project.name}”`);
    const cause = restricted.length ? `the filesystem restriction on ${restricted.length === 1 ? "project" : "projects"} ${restricted.join(", ")}` : "a project's filesystem restriction";
    return `Paused by ${cause}. While any project restricts file access, agents, terminals, provider checks and other app-managed work pause in every project (current backends can't enforce path rules), and unscoped history is hidden. Review it in Settings → Projects.`;
  }
  private projectIds(repo: string, run?: Run | RunSummary): string[] {
    const related = new Set([repo]); const owned = this.manager.relatedRuns(repo);
    for (const item of owned) related.add(item.repo);
    return [...new Set([...this.projects.list().filter((project) => project.repos.some((repo) => related.has(repo))).map((project) => project.id), ...owned.flatMap((item) => item.project ? [item.project] : []), ...(run?.project ? [run.project] : [])])];
  }
  async forRepo(repo: string, run?: Run | RunSummary) { const policies = await Promise.all(this.projectIds(repo, run).map(async (id) => { const policy = await this.store.get(id); this.cache.set(id, policy); return policy; })); return [...policies, ...((run as Run & { filePolicies?: FilePolicySnapshot[] } | undefined)?.filePolicies ?? [])]; }
  async execution(repo: string, run?: Run) { if (this.activating) throw new FilePolicyError("Filesystem policy is being applied; execution preparation is paused", 409); return [...await this.all(), ...await this.forRepo(repo, run)]; }
  restrictedRun(run: Run | RunSummary): boolean {
    const pinned = !!(run as Run & { filePolicies?: FilePolicySnapshot[] }).filePolicies?.some(policyIsRestrictive);
    // Avoid rebuilding repository ownership for every indexed run on unrestricted hosts.
    if (!this.hasRestrictions()) return pinned;
    return pinned || this.projectIds(run.repo, run).some(id => { const policy = this.cache.get(id); return !!policy && policyIsRestrictive(policy); });
  }
  list() { return this.manager.list().filter((run) => !this.restrictedRun(run)); }
  page(input: Parameters<RunManager["page"]>[0] = {}) {
    return this.manager.page({ ...input, ...(this.hasRestrictions() ? { predicate: (run) => !this.restrictedRun(run) && (input.predicate?.(run) ?? true) } : {}) });
  }
  end(req: IncomingMessage) { this.operations.delete(req); }
  async sharedGate(req: IncomingMessage) { if (this.activating) throw new FilePolicyError("Filesystem policy is being applied; retry after it finishes", 409); this.operations.add(req); await this.all(); }
  async update(projectId: string, input: { revision: unknown; read: unknown; write: unknown }, activate: (commit: () => Promise<void>, next: FilePolicySnapshot) => Promise<void>) {
    if (this.activating || this.operations.size) throw new FilePolicyError("Wait for active application operations to finish before changing filesystem policy", 409);
    this.activating = true;
    try {
      // Saving the rules already in force commits nothing: no new revision, and nothing paused or closed for it.
      return await this.store.unchanged(projectId, input) ?? await this.store.set(projectId, input, async (commit, next) => activate(commit, next));
    }
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
    const run = parts[1] === "runs" && parts[2] ? await this.manager.getAsync(parts[2]) : undefined;
    const policyProject = parts[1] === "projects" && parts[2] ? this.cache.get(parts[2]) : typeof body.project === "string" ? this.cache.get(body.project) : undefined;
    const targetRestricted = !!run && this.restrictedRun(run) || !!policyProject && policyIsRestrictive(policyProject) || !!selected && (await this.forRepo(selected)).some(policyIsRestrictive);
    const fileApi = parts[1] === "file" && req.method === "GET" || parts[1] === "workspace" && parts[2] === "file" && ["GET", "POST"].includes(req.method ?? "");
    const safeSearch = req.method === "GET" && (["tree", "search"].includes(parts[1] ?? "") || parts[1] === "workspace" && parts[2] === "search" && url.searchParams.get("mode") !== "semantic");
    const filteredDiff = req.method === "GET" && parts[1] === "runs" && parts[3] === "diff";
    if (targetRestricted && !fileApi && !safeSearch && !filteredDiff) throw new FilePolicyError("This project's filesystem policy blocks raw history, configuration and operations that cannot enforce its paths", req.method === "GET" ? 403 : 409);
    if (globallyRestricted) {
      const segment = parts[1] ?? "";
      // Closing a terminal only gives up authority: a stray one can always be closed.
      const closing = segment === "shell" && req.method === "DELETE";
      const unclassified = ![RESTRICTED_PRIVATE_ROUTES, RESTRICTED_EXECUTION_ROUTES, RESTRICTION_OPEN_ROUTES].some((routes) => routes.includes(segment));
      const globalPrivate = !closing && (unclassified || RESTRICTED_PRIVATE_ROUTES.includes(segment));
      const execution = req.method !== "GET" && (RESTRICTED_EXECUTION_ROUTES.includes(segment) || segment === "workspace" && !fileApi);
      if (globalPrivate || execution || segment === "workspace" && ["references", "dependencies"].includes(parts[2] ?? "") || segment === "workspace" && parts[2] === "search" && url.searchParams.get("mode") === "semantic") throw new FilePolicyError(this.pauseMessage(), req.method === "GET" ? 403 : 409);
    }
  }
}
