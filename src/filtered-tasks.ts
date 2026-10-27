import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CODEFLOW_HOME } from "./config.js";
import { childEnv } from "./env.js";
import { allowsFilePolicy, allowsFilePolicyDirectory, normalizePolicyPath, validateFilePolicySnapshot, type FilePolicySnapshot } from "./filesystem-policy.js";
import { sensitiveContextPath } from "./context-inspection.js";
import { getAdapter, type AgentEvent, type RunResult } from "./adapters/index.js";
import { filteredTaskContainer } from "./agent-container.js";
import { redactExport } from "./privacy.js";
import { inspectFilteredWorkspace, monitorFilteredWorkspace } from "./filtered-task-limits.js";
import { durableWorkerDirectory } from "./remote-workers/durability.js";
import { FILTERED_TASK_BYTES, filteredTaskCancellable } from "./filtered-task-state.js";

const MAX_FILES = 500, MAX_FILE = 512 * 1024, MAX_TOTAL = 16 * 1024 * 1024, MAX_JOBS = 100;
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const idPattern = /^filtered-[a-f0-9]{24}$/;
type Mode = "100644" | "100755";
interface FileRecord { path: string; hash: string; mode: Mode; bytes: number; blob?: string }
export interface FilteredChange { path: string; status: "added" | "modified" | "deleted"; beforeHash?: string; afterHash?: string; mode?: Mode; bytes: number; binary?: boolean; before?: string; after?: string; truncated?: boolean }
export interface FilteredTask {
  version: 1; id: string; revision: number; project: string; repo: string; task: string; agent: "claude" | "codex" | "agy"; image: string; imageId?: string; network: boolean; maxMinutes: number;
  status: "preparing" | "running" | "completed" | "failed" | "cancelled" | "unknown" | "importing" | "imported"; createdAt: number; updatedAt: number;
  sourceHead?: string; policies: FilePolicySnapshot[]; base: FileRecord[]; result?: FileRecord[]; resultHash?: string; finalText?: string; error?: string; events: { at: number; text: string }[];
  containerStopped: boolean; importBranch?: string; importCommit?: string;
}
export class FilteredTaskError extends Error { constructor(message: string, readonly status = 409) { super(message); } }
export interface FilteredTaskRuntime {
  pinImage(image: string): Promise<string>;
  run(job: FilteredTask, workspace: string, signal: AbortSignal, onEvent: (event: AgentEvent) => void): Promise<RunResult>;
  stop(jobId: string): Promise<void>;
}
const safeEnv = (extra: NodeJS.ProcessEnv = {}) => { const environment = childEnv(); for (const key of Object.keys(environment)) if (key.startsWith("GIT_")) delete environment[key]; return { ...environment, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0", GIT_ATTR_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...extra }; };
function execute(command: string, args: string[], options: { cwd?: string; input?: string | Buffer; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => { const child = execFile(command, args, { cwd: options.cwd, env: options.env ?? safeEnv(), encoding: "buffer", timeout: options.timeout ?? 30_000, maxBuffer: options.maxBuffer ?? MAX_TOTAL + 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new FilteredTaskError(`${command} failed: ${String(stderr).slice(-2000) || error.message}`, 422)) : resolve(stdout)); child.stdin?.on("error", () => undefined); child.stdin?.end(options.input); });
}
async function git(repo: string, args: string[], options: { input?: string | Buffer; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {}) { return execute("git", ["--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.attributesFile=/dev/null", "-c", "core.sparseCheckout=false", "-c", "protocol.allow=never", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "commit.gpgSign=false", ...args], { cwd: repo, ...options, env: safeEnv(options.env) }); }
export const dockerFilteredRuntime: FilteredTaskRuntime = {
  async pinImage(image) {
    if (!/^[a-zA-Z0-9][\w./:@-]{0,199}$/.test(image)) throw new FilteredTaskError("Choose an explicitly prepared local Docker image", 400);
    if (process.env.DOCKER_HOST && !/^(unix|npipe):\/\//.test(process.env.DOCKER_HOST)) throw new FilteredTaskError("Filtered tasks require a local Docker daemon");
    const endpoint = (await execute("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { timeout: 10_000 })).toString().trim(); if (!/^(unix|npipe):\/\//.test(endpoint)) throw new FilteredTaskError("Filtered tasks require a local Docker context");
    const id = (await execute("docker", ["image", "inspect", "--format", "{{.Id}}", image], { timeout: 10_000 })).toString().trim(); if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new FilteredTaskError("Docker did not return an immutable image identity"); return id;
  },
  async run(job, workspace, signal, onEvent) {
    const container = filteredTaskContainer({ image: job.imageId!, network: job.network, memoryMb: 4096, cpus: 2 }, job.id, job.base.filter((file) => !permitted(job.policies, "write", file.path)).map((file) => file.path));
    return getAdapter(job.agent).run({ cwd: workspace, prompt: `This is a filtered committed repository snapshot. Original history, ignored files, denied paths, host credentials and private application memory are absent. Work only in this directory. Changes outside the permitted import paths will be rejected. Do not modify .git.\n\nTask:\n${job.task}`, mode: "write", trust: "safe", signal, timeoutMs: job.maxMinutes * 60_000, agentContainer: container, questionProtocol: "structured", interactiveApprovals: false }, onEvent);
  },
  async stop(jobId) {
    if (!idPattern.test(jobId)) throw new FilteredTaskError("Invalid filtered task identity", 400);
    const listed = (await execute("docker", ["ps", "-aq", "--filter", "label=codeflow.managed-agent=true", "--filter", `label=codeflow.filtered-task=${jobId}`], { timeout: 10_000 })).toString().trim().split(/\s+/).filter(Boolean);
    if (listed.some((id) => !/^[a-f0-9]{12,64}$/.test(id))) throw new FilteredTaskError("Docker returned an ambiguous container receipt");
    if (listed.length) await execute("docker", ["rm", "--force", ...listed], { timeout: 15_000 });
    const remaining = (await execute("docker", ["ps", "-aq", "--filter", `label=codeflow.filtered-task=${jobId}`], { timeout: 10_000 })).toString().trim(); if (remaining) throw new FilteredTaskError("The filtered task's daemon container could not be confirmed stopped");
  },
};
interface Options { home?: string; runtime?: FilteredTaskRuntime; authorize: (project: string, repo: string) => Promise<FilePolicySnapshot[]>; withRepository: <T>(repo: string, operation: () => Promise<T>) => Promise<T> }
const policyIdentity = (policies: readonly FilePolicySnapshot[]) => sha(JSON.stringify(policies.map((policy) => [policy.projectId, policy.revision, policy.hash]).sort()));
const permitted = (policies: readonly FilePolicySnapshot[], operation: "read" | "write", path: string) => !sensitiveContextPath(path) && policies.every((policy) => allowsFilePolicy(policy, operation, path));
/** Result paths are untrusted container output: redacted and bounded before they reach an error. */
const listed = (paths: readonly string[]) => { const shown = paths.slice(0, 5).map((path) => String(redactExport(path)).slice(0, 200)).join(", "); return paths.length > 5 ? `${shown} and ${paths.length - 5} more` : shown; };
const resultIdentity = (files: readonly FileRecord[]) => sha(JSON.stringify(files.map(({ path, hash, mode, bytes }) => ({ path, hash, mode, bytes })).sort((a, b) => a.path.localeCompare(b.path))));
export class FilteredTasks {
  private jobs = new Map<string, FilteredTask>(); private controllers = new Map<string, AbortController>(); private work = new Map<string, Promise<void>>(); private writes = new Map<string, Promise<unknown>>(); private preparations = new Map<string, Promise<void>>(); private importClaims = new Set<string>(); private importWork = new Map<string, Promise<unknown>>(); private mutations = new Map<string, Promise<unknown>>(); private reservations = 0; private loaded = false; private closing = false;
  private readonly directory: string; private readonly runtime: FilteredTaskRuntime;
  constructor(private options: Options) { this.directory = join(options.home ?? CODEFLOW_HOME, "filtered-tasks"); this.runtime = options.runtime ?? dockerFilteredRuntime; }
  private directoryFor(id: string) { if (!idPattern.test(id)) throw new FilteredTaskError("Invalid filtered task", 400); return join(this.directory, id); }
  private workspace(id: string) { return join(this.directoryFor(id), "workspace"); }
  list(project?: string) { return [...this.jobs.values()].filter((job) => !project || job.project === project).sort((a, b) => b.createdAt - a.createdAt).map((job) => this.get(job.id)); }
  summaries(project?: string) { return [...this.jobs.values()].filter((job) => !project || job.project === project).sort((a, b) => b.createdAt - a.createdAt).map(({ id, revision, project, status, createdAt, updatedAt, containerStopped, importBranch, importCommit }) => ({ id, revision, project, status, createdAt, updatedAt, containerStopped, importBranch, importCommit })); }
  async read(id: string) { const job = this.require(id); const policies = await this.options.authorize(job.project, job.repo); if (policyIdentity(policies) !== policyIdentity(job.policies)) throw new FilteredTaskError("Historical task content is unavailable after its filesystem policy changed; metadata and explicit cancellation remain available", 403); return this.get(id); }
  get(id: string) { const job = this.require(id); const { base: _base, result: _result, policies: _policies, ...view } = job; return structuredClone({ ...view, exportedFiles: job.base.length, exportedBytes: job.base.reduce((sum, file) => sum + file.bytes, 0), policyRevisions: job.policies.map(({ projectId, revision, hash }) => ({ projectId, revision, hash })) }); }
  active() { return !!this.reservations || !!this.importClaims.size || !!this.mutations.size || [...this.jobs.values()].some((job) => ["preparing", "running", "importing"].includes(job.status) || !job.containerStopped); }
  private mutation<T>(id: string, operation: () => Promise<T>) { this.require(id); if (this.closing || this.mutations.has(id) || this.importClaims.has(id)) throw new FilteredTaskError("Another import or task mutation is already claimed, or the service is closing"); const work = Promise.resolve().then(operation); this.mutations.set(id, work); void work.finally(() => { if (this.mutations.get(id) === work) this.mutations.delete(id); }).catch(() => undefined); return work; }
  private require(id: string) { const job = this.jobs.get(id); if (!job) throw new FilteredTaskError("Filtered task not found", 404); return job; }
  async load() {
    await durableWorkerDirectory(this.directory); const info = await lstat(this.directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new FilteredTaskError("Filtered task storage is not a private regular directory", 503);
    const storageParent = await open(dirname(this.directory), "r"); try { await storageParent.sync(); } finally { await storageParent.close(); }
    const entries = await readdir(this.directory); if (entries.length > MAX_JOBS) throw new FilteredTaskError("Filtered task history exceeds its bound", 503);
    for (const id of entries) {
      if (!idPattern.test(id)) throw new FilteredTaskError("Unrecognized filtered task storage entry", 503);
      const folder = this.directoryFor(id); const metadata = await lstat(folder); if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new FilteredTaskError("Symbolic filtered task storage is refused", 503);
      const handle = await open(join(folder, "job.json"), constants.O_RDONLY | constants.O_NOFOLLOW); let job: FilteredTask;
      try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("Unbounded job record"); job = JSON.parse(await handle.readFile("utf8")); }
      finally { await handle.close(); }
      if (job!.version !== 1 || job!.id !== id || !Number.isSafeInteger(job!.revision) || !Array.isArray(job!.base) || job!.base.length > MAX_FILES || !Array.isArray(job!.policies) || !Array.isArray(job!.events) || job!.events.length > 100 || !["preparing", "running", "completed", "failed", "cancelled", "unknown", "importing", "imported"].includes(job!.status)) throw new FilteredTaskError("Invalid filtered task metadata; repair private storage", 503);
      job.policies = job.policies.map(validateFilePolicySnapshot);
      const records = (files: FileRecord[], baseline: boolean) => { let bytes = 0; const paths = new Set<string>(); if (!Array.isArray(files) || files.length > MAX_FILES) throw new FilteredTaskError("Unbounded filtered task manifest", 503); for (const file of files) { if (!file || normalizePolicyPath(file.path) !== file.path || sensitiveContextPath(file.path) || paths.has(file.path) || !/^[a-f0-9]{64}$/.test(file.hash) || !["100644", "100755"].includes(file.mode) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE || (bytes += file.bytes) > MAX_TOTAL || baseline && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(file.blob ?? "")) throw new FilteredTaskError("Invalid filtered task manifest", 503); paths.add(file.path); } };
      records(job.base, true); if (job.result) records(job.result, false); if (job.sourceHead && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(job.sourceHead) || job.importBranch && job.importBranch !== `codeflow/${id}` || job.importCommit && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(job.importCommit)) throw new FilteredTaskError("Invalid filtered task source/import identity", 503);
      this.jobs.set(id, job!); if (["preparing", "running", "importing"].includes(job!.status)) await this.save(job!, { status: "unknown", error: "Application restarted during an effectful phase. Inspect an import receipt or cancel and confirm the owned Docker container stopped; this task will not retry automatically." });
    }
    this.loaded = true;
  }
  private async save(job: FilteredTask, patch: Partial<FilteredTask>) {
    const work = (this.writes.get(job.id) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const next = { ...job, ...patch, revision: job.revision + 1, updatedAt: Date.now() }, folder = this.directoryFor(job.id), file = join(folder, "job.json"), temp = join(folder, `.job-${randomBytes(6).toString("hex")}.tmp`);
      const handle = await open(temp, "wx", 0o600); try { await handle.writeFile(JSON.stringify(next)); await handle.sync(); } finally { await handle.close(); }
      try { await rename(temp, file); const directory = await open(folder, "r"); try { await directory.sync(); } finally { await directory.close(); } Object.assign(job, next); } finally { await rm(temp, { force: true }).catch(() => undefined); }
    }); this.writes.set(job.id, work); try { await work; } finally { if (this.writes.get(job.id) === work) this.writes.delete(job.id); }
  }
  private async current(job: FilteredTask) {
    const policies = await this.options.authorize(job.project, job.repo); if (policyIdentity(policies) !== policyIdentity(job.policies)) throw new FilteredTaskError("Filesystem policy revision or project membership changed; prepare a new filtered task");
    job.policies = structuredClone(policies);
    if ((await git(job.repo, ["rev-parse", "--verify", "HEAD^{commit}"])).toString().trim() !== job.sourceHead) throw new FilteredTaskError("Original source revision changed; prepare a new filtered task");
    const source = (await git(job.repo, ["ls-tree", "-rz", "-l", "--full-tree", job.sourceHead!], { maxBuffer: 8 * 1024 * 1024 })).toString("utf8").split("\0").filter(Boolean); const records = new Map(source.map((entry) => { const match = /^(\d{6}) (blob|commit) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/.exec(entry); if (!match) throw new FilteredTaskError("Source tree contains an unsupported record"); return [match[5]!, { mode: match[1], blob: match[3], bytes: Number(match[4]) }]; }));
    for (const file of job.base) { const original = records.get(file.path); if (!permitted(policies, "read", file.path) || !original || original.blob !== file.blob || original.mode !== file.mode || original.bytes !== file.bytes) throw new FilteredTaskError("Stored export manifest does not match the authorized source revision"); }
  }
  async create(raw: { project: unknown; repo: unknown; task: unknown; agent: unknown; image: unknown; network?: unknown; maxMinutes?: unknown }) {
    if (!this.loaded || this.closing) throw new FilteredTaskError("Filtered task service is unavailable or closing", 503);
    if (this.reservations || this.active()) throw new FilteredTaskError("Another filtered task is still preparing, running, importing or awaiting a confirmed container stop; wait for it or cancel it before starting another");
    if (this.jobs.size >= MAX_JOBS) throw new FilteredTaskError(`Filtered task history is full (${MAX_JOBS} tasks); delete a finished task before starting another`);
    const invalid = (message: string) => new FilteredTaskError(message, 400);
    if (typeof raw.project !== "string" || !raw.project) throw invalid("Choose a project for the filtered task");
    if (typeof raw.repo !== "string" || !raw.repo.startsWith("/")) throw invalid("Choose a repository by its absolute path");
    if (typeof raw.task !== "string" || !raw.task.trim()) throw invalid("Enter the filtered task instructions");
    if (Buffer.byteLength(raw.task) > FILTERED_TASK_BYTES) throw invalid(`Filtered task instructions exceed ${FILTERED_TASK_BYTES / 1024} KB (UTF-8 bytes); shorten them`);
    if (!["claude", "codex", "agy"].includes(String(raw.agent))) throw invalid("Choose a supported provider: claude, codex or agy");
    if (typeof raw.image !== "string" || !raw.image.trim()) throw invalid("Enter a prepared local Docker image");
    if (raw.network !== undefined && typeof raw.network !== "boolean") throw invalid("Network access must be true or false");
    if (raw.maxMinutes !== undefined && (!Number.isInteger(raw.maxMinutes) || (raw.maxMinutes as number) < 1 || (raw.maxMinutes as number) > 30)) throw invalid("Choose a time limit of 1–30 whole minutes");
    this.reservations++;
    const id = `filtered-${randomBytes(12).toString("hex")}`, folder = this.directoryFor(id); let repo = raw.repo;
    const controller = new AbortController(); this.controllers.set(id, controller); let preparationDone!: () => void; this.preparations.set(id, new Promise<void>((resolve) => { preparationDone = resolve; }));
    const checkPreparation = () => { if (this.closing || controller.signal.aborted) throw new FilteredTaskError("Filtered task preparation cancelled before provider dispatch"); };
    const job: FilteredTask = { version: 1, id, revision: 0, project: raw.project, repo, task: raw.task.trim(), agent: raw.agent as FilteredTask["agent"], image: raw.image, network: raw.network === true, maxMinutes: raw.maxMinutes as number ?? 10, status: "preparing", createdAt: Date.now(), updatedAt: Date.now(), policies: [], base: [], events: [], containerStopped: true };
    try {
      checkPreparation(); repo = await realpath(repo); job.repo = repo;
      job.policies = await this.options.authorize(job.project, repo); if (!job.policies.length) throw new FilteredTaskError("Assign this repository to the selected project before preparing a filtered task");
      await mkdir(folder, { mode: 0o700 }); const directory = await open(this.directory, "r"); try { await directory.sync(); } finally { await directory.close(); } this.jobs.set(id, job); await this.save(job, {});
      await this.options.withRepository(repo, async () => {
        checkPreparation(); job.sourceHead = (await git(repo, ["rev-parse", "--verify", "HEAD^{commit}"])).toString().trim(); job.imageId = await this.runtime.pinImage(job.image); checkPreparation(); if (!/^sha256:[a-f0-9]{64}$/.test(job.imageId)) throw new FilteredTaskError("Runtime image identity is not immutable");
        await mkdir(this.workspace(id), { mode: 0o700 });
        const tree = (await git(repo, ["ls-tree", "-rz", "-l", "--full-tree", job.sourceHead], { maxBuffer: 8 * 1024 * 1024 })).toString("utf8").split("\0").filter(Boolean); let bytes = 0;
        for (const entry of tree) {
          checkPreparation();
          const match = /^(\d{6}) (blob|commit) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/.exec(entry); if (!match) throw new FilteredTaskError("Source tree contains an unsupported record"); const path = normalizePolicyPath(match[5]); if (!permitted(job.policies, "read", path)) continue;
          if (!["100644", "100755"].includes(match[1]!) || match[2] !== "blob") throw new FilteredTaskError("Readable symlinks and Gitlinks are unsupported in a filtered snapshot");
          const size = Number(match[4]); if (job.base.length >= MAX_FILES || size > MAX_FILE || (bytes += size) > MAX_TOTAL) throw new FilteredTaskError("Filtered source exceeds 500 files, 512 KB per file or 16 MB total");
          const contents = await git(repo, ["cat-file", "blob", match[3]!], { maxBuffer: MAX_FILE + 1 }); if (contents.length !== size) throw new FilteredTaskError("Source blob size changed"); const target = join(this.workspace(id), path); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); const handle = await open(target, "wx", match[1] === "100755" ? 0o700 : 0o600); try { await handle.writeFile(contents); } finally { await handle.close(); }
          job.base.push({ path, hash: sha(contents), mode: match[1] as Mode, bytes: size, blob: match[3] });
        }
        await git(this.workspace(id), ["init", "-q", "--template=", "-b", "main"]); await git(this.workspace(id), ["add", "--force", "-A", "--", "."]); await git(this.workspace(id), ["-c", "user.name=code-flow filtered snapshot", "-c", "user.email=filtered@localhost", "commit", "--allow-empty", "-qm", "Filtered committed snapshot"]);
        await this.current(job); checkPreparation(); await this.save(job, { sourceHead: job.sourceHead, imageId: job.imageId, base: job.base, policies: job.policies, status: "running", containerStopped: false }); checkPreparation();
      });
      checkPreparation(); const work = this.launch(job, controller); this.work.set(id, work); void work.finally(() => { this.controllers.delete(id); this.work.delete(id); }).catch(() => undefined); return this.get(id);
    } catch (error) { if (this.jobs.has(id)) await this.save(job, { status: controller.signal.aborted || this.closing ? "cancelled" : "failed", error: (error as Error).message, containerStopped: true }); throw error; }
    finally { this.reservations--; preparationDone(); this.preparations.delete(id); if (!this.work.has(id)) this.controllers.delete(id); }
  }
  private async scan(job: FilteredTask): Promise<FileRecord[]> {
    const root = await lstat(this.workspace(job.id)); if (!root.isDirectory() || root.isSymbolicLink()) throw new FilteredTaskError("Filtered export root must be a regular private directory");
    await inspectFilteredWorkspace(this.workspace(job.id));
    const files: FileRecord[] = []; let bytes = 0;
    const walk = async (relative: string, depth: number) => {
      if (depth > 30) throw new FilteredTaskError("Result directory depth exceeds its bound"); const folder = join(this.workspace(job.id), relative); const entries = await readdir(folder, { withFileTypes: true }); if (entries.length > 1000) throw new FilteredTaskError("Result directory exceeds its entry bound");
      for (const entry of entries) { const path = normalizePolicyPath(relative ? `${relative}/${entry.name}` : entry.name); const absolute = join(this.workspace(job.id), path), info = await lstat(absolute); if (info.isSymbolicLink()) throw new FilteredTaskError("Result symlinks are refused"); if (info.isDirectory()) { if (!job.policies.every((policy) => allowsFilePolicyDirectory(policy, path))) throw new FilteredTaskError(`Result contains a forbidden directory: ${listed([path])}`); await walk(path, depth + 1); continue; } if (!permitted(job.policies, "read", path)) throw new FilteredTaskError(`Result contains a forbidden path; no changes will be imported: ${listed([path])}`); if (!info.isFile() || info.nlink !== 1 || info.size > MAX_FILE || files.length >= MAX_FILES || (bytes += info.size) > MAX_TOTAL) throw new FilteredTaskError("Result contains a special/hard-linked file or exceeds its bounded file count/size"); const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW); let content: Buffer; try { content = await handle.readFile(); } finally { await handle.close(); } if (content.length !== info.size || content.length > MAX_FILE) throw new FilteredTaskError("Result file changed during validation"); files.push({ path, hash: sha(content), mode: info.mode & 0o111 ? "100755" : "100644", bytes: content.length }); }
    }; await walk("", 0);
    const denied: string[] = [];
    for (const path of new Set([...job.base, ...files].map((file) => file.path))) { const before = job.base.find((file) => file.path === path), after = files.find((file) => file.path === path); if ((!before || !after || before.hash !== after.hash || before.mode !== after.mode) && !permitted(job.policies, "write", path)) denied.push(path); }
    if (denied.length) throw new FilteredTaskError(`Result modified ${denied.length === 1 ? "a path" : "paths"} outside the write policy; nothing will be imported: ${listed(denied.sort())}`);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
  private async launch(job: FilteredTask, controller: AbortController) {
    try {
      await this.current(job); if ((await this.runtime.pinImage(job.imageId!)) !== job.imageId) throw new FilteredTaskError("Pinned Docker image changed"); if (controller.signal.aborted || this.closing) throw new FilteredTaskError("Filtered task cancelled before provider dispatch"); await this.current(job); if (controller.signal.aborted || this.closing) throw new FilteredTaskError("Filtered task cancelled before provider dispatch");
      let exceeded: Error | undefined; const monitor = monitorFilteredWorkspace(this.workspace(job.id), { signal: controller.signal, onExceeded: (error) => { exceeded = error; controller.abort(); } });
      let result: RunResult;
      try { result = await this.runtime.run(structuredClone(job), this.workspace(job.id), controller.signal, (event) => { const text = event.kind === "status" || event.kind === "text" ? event.text : event.kind === "error" ? event.message : undefined; if (text) job.events = [...job.events, { at: Date.now(), text: String(redactExport(text)).slice(0, 1000) }].slice(-100); }); }
      finally { await monitor.stop(); }
      if (exceeded) throw exceeded;
      await this.runtime.stop(job.id); await this.save(job, { containerStopped: true }); if (controller.signal.aborted) { await this.save(job, { status: "cancelled", error: "Cancelled after confirming the daemon container stopped" }); return; }
      // Never inspect untrusted exported Git metadata. Remove it before any host-side result work.
      await rm(join(this.workspace(job.id), ".git"), { recursive: true, force: true }); await this.current(job); if (!result.ok) throw new FilteredTaskError(result.error || "Provider turn failed"); const files = await this.scan(job);
      await this.save(job, { status: "completed", result: files, resultHash: resultIdentity(files), finalText: String(redactExport(result.finalText)).slice(0, 32 * 1024) });
    } catch (error) {
      let stopped = false; try { await this.runtime.stop(job.id); stopped = true; } catch { /* An unconfirmed daemon receipt remains a blocking unknown job. */ }
      await this.save(job, { status: stopped ? controller.signal.aborted ? "cancelled" : "failed" : "unknown", containerStopped: stopped, error: (error as Error).message });
    }
  }
  async cancel(id: string, revision: unknown) { return this.mutation(id, async () => {
    const job = this.require(id); if (revision !== job.revision) throw new FilteredTaskError("Filtered task changed; refresh its current state"); if (this.importClaims.has(id) || job.status === "importing" || job.importCommit && job.status === "unknown") throw new FilteredTaskError("Inspect the interrupted import receipt before changing this job");
    if (!filteredTaskCancellable(job)) throw new FilteredTaskError("This filtered task has finished and its container is confirmed stopped, so there is nothing to cancel; delete it to discard its result");
    this.controllers.get(id)?.abort(); await this.preparations.get(id); await this.work.get(id); await this.runtime.stop(id); await this.save(job, { status: "cancelled", containerStopped: true, error: "Owner cancelled; daemon container absence confirmed" }); return this.get(id);
  }); }
  async preview(id: string) {
    const job = this.require(id); if (job.status !== "completed") throw new FilteredTaskError("Only a completed validated task has an import preview"); await this.current(job); const files = await this.scan(job); if (resultIdentity(files) !== job.resultHash) throw new FilteredTaskError("Result changed after completion; import is refused"); const changes: FilteredChange[] = []; let previewBytes = 0;
    for (const path of [...new Set([...job.base, ...files].map((file) => file.path))].sort()) { const before = job.base.find((file) => file.path === path), after = files.find((file) => file.path === path); if (before?.hash === after?.hash && before?.mode === after?.mode) continue; const change: FilteredChange = { path, status: !before ? "added" : !after ? "deleted" : "modified", beforeHash: before?.hash, afterHash: after?.hash, mode: after?.mode, bytes: after?.bytes ?? 0 }; const source = before ? await git(job.repo, ["cat-file", "blob", before.blob!], { maxBuffer: MAX_FILE + 1 }) : Buffer.alloc(0), target = after ? await this.content(job, after) : Buffer.alloc(0); change.binary = source.includes(0) || target.includes(0); if (!change.binary && previewBytes < 512 * 1024) { change.before = source.toString("utf8").slice(0, 20_000); change.after = target.toString("utf8").slice(0, 20_000); previewBytes += Buffer.byteLength(change.before) + Buffer.byteLength(change.after); change.truncated = source.length > 20_000 || target.length > 20_000; } else change.truncated = true; changes.push(change); }
    return { job: this.get(id), sourceHead: job.sourceHead, resultHash: job.resultHash, changes, importBehavior: "Creates a new review branch; original checkout and index remain unchanged" };
  }
  private async content(job: FilteredTask, file: FileRecord) { const handle = await open(join(this.workspace(job.id), file.path), constants.O_RDONLY | constants.O_NOFOLLOW); try { const bytes = await handle.readFile(); if (bytes.length > MAX_FILE || sha(bytes) !== file.hash) throw new FilteredTaskError("Result changed before import"); return bytes; } finally { await handle.close(); } }
  async import(id: string, input: { revision: unknown; expectedHead: unknown; resultHash: unknown }) {
    const job = this.require(id); if (job.status !== "completed" || input.revision !== job.revision || input.expectedHead !== job.sourceHead || input.resultHash !== job.resultHash) throw new FilteredTaskError("Refresh and review the exact current completed result before import");
    if (this.closing || this.importClaims.has(id) || this.mutations.has(id)) throw new FilteredTaskError("An import or task mutation is already claimed or the service is closing"); this.importClaims.add(id); const work = this.importClaimed(job); this.importWork.set(id, work); void work.finally(() => { this.importClaims.delete(id); this.importWork.delete(id); }).catch(() => undefined); return work;
  }
  private async importClaimed(job: FilteredTask) {
    const id = job.id;
    return this.options.withRepository(job.repo, async () => {
      if (this.closing) throw new FilteredTaskError("Import stopped before publication");
      await this.current(job); const preview = await this.preview(id); if (!preview.changes.length) throw new FilteredTaskError("The filtered task has no changes to import");
      const assertOriginalFiles = async () => {
      const staged = (await git(job.repo, ["ls-files", "--stage", "-z"])).toString().split("\0").filter(Boolean); const index = new Map(staged.map((entry) => { const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry); if (!match || match[3] !== "0") throw new FilteredTaskError("Resolve the original index's conflicts before importing"); return [match[4]!, { mode: match[1], blob: match[2] }]; }));
      for (const change of preview.changes) {
        const baseline = job.base.find((file) => file.path === change.path); let currentPath = job.repo; for (const component of change.path.split("/")) { currentPath = join(currentPath, component); const entry = await lstat(currentPath).catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }); if (entry?.isSymbolicLink()) throw new FilteredTaskError("Original source path became symbolic; import refused"); }
        const info = await lstat(currentPath).catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }); if (!baseline) { if (info || index.has(change.path)) throw new FilteredTaskError("A new result path already exists in the original checkout/index"); }
        else { if (!info?.isFile() || info.size > MAX_FILE || index.get(change.path)?.blob !== baseline.blob || index.get(change.path)?.mode !== baseline.mode || (info.mode & 0o111 ? "100755" : "100644") !== baseline.mode) throw new FilteredTaskError("Original file mode/index changed; import refused"); const file = await open(currentPath, constants.O_RDONLY | constants.O_NOFOLLOW); try { if (sha(await file.readFile()) !== baseline.hash) throw new FilteredTaskError("Original file contents changed; import refused"); } finally { await file.close(); } }
      }
      }; await assertOriginalFiles();
      const temporaryIndex = join(this.directoryFor(id), `index-${randomBytes(6).toString("hex")}`), env = { GIT_INDEX_FILE: temporaryIndex }; let commit: string;
      try { await git(job.repo, ["read-tree", job.sourceHead!], { env }); for (const change of preview.changes) { const file = job.result!.find((file) => file.path === change.path); if (!file) await git(job.repo, ["update-index", "--force-remove", "--", change.path], { env }); else { const blob = (await git(job.repo, ["hash-object", "--no-filters", "-w", "--stdin"], { input: await this.content(job, file), env })).toString().trim(); await git(job.repo, ["update-index", "--add", "--cacheinfo", file.mode, blob, file.path], { env }); } } const tree = (await git(job.repo, ["write-tree"], { env })).toString().trim(); commit = (await git(job.repo, ["-c", "user.name=code-flow filtered task", "-c", "user.email=filtered@localhost", "commit-tree", tree, "-p", job.sourceHead!], { input: `Filtered task ${job.id}\n`, env })).toString().trim(); }
      finally { await rm(temporaryIndex, { force: true }); await rm(`${temporaryIndex}.lock`, { force: true }); }
      await this.current(job); if (resultIdentity(await this.scan(job)) !== job.resultHash) throw new FilteredTaskError("Result changed during import preparation"); const branch = `codeflow/${job.id}`;
      if (this.closing) throw new FilteredTaskError("Import stopped before publication"); await this.save(job, { status: "importing", importBranch: branch, importCommit: commit });
      try { if (this.closing) throw new FilteredTaskError("Import stopped before publication"); await this.current(job); await assertOriginalFiles(); if (this.closing) throw new FilteredTaskError("Import stopped before publication"); await git(job.repo, ["update-ref", "--stdin"], { input: `start\nverify HEAD ${job.sourceHead}\ncreate refs/heads/${branch} ${commit}\nprepare\ncommit\n` }); await this.save(job, { status: "imported" }); }
      catch (error) { await this.save(job, { status: "unknown", error: "Import receipt is ambiguous. Inspect it explicitly; no automatic retry is allowed." }); throw error; }
      return this.get(id);
    });
  }
  async reconcile(id: string, revision: unknown) { return this.mutation(id, async () => { const job = this.require(id); if (job.status !== "unknown" || revision !== job.revision || !job.importCommit || !job.importBranch) throw new FilteredTaskError("There is no matching interrupted import receipt"); await this.options.authorize(job.project, job.repo); const ref = await git(job.repo, ["show-ref", "--verify", "--hash", `refs/heads/${job.importBranch}`]).then((buffer) => buffer.toString().trim(), () => ""); if (ref && ref !== job.importCommit) throw new FilteredTaskError("The review branch no longer matches the saved import receipt"); await this.save(job, { status: ref ? "imported" : "completed", error: ref ? undefined : "The atomic branch transaction did not publish a ref; review again before an explicit retry.", ...(ref ? {} : { importBranch: undefined, importCommit: undefined }) }); return this.get(id); }); }
  async delete(id: string, revision: unknown) { return this.mutation(id, async () => { const job = this.require(id); if (revision !== job.revision || this.importClaims.has(id) || this.preparations.has(id) || this.work.has(id) || !job.containerStopped || ["preparing", "running", "importing", "unknown"].includes(job.status)) throw new FilteredTaskError("Only a terminal task with a confirmed stopped container and no ambiguous import may be deleted"); await this.writes.get(id); await rm(this.directoryFor(id), { recursive: true, force: false }); const directory = await open(this.directory, "r"); try { await directory.sync(); } finally { await directory.close(); } this.jobs.delete(id); return { deleted: true, preservedReviewBranch: job.importBranch }; }); }
  async close() { this.closing = true; for (const controller of this.controllers.values()) controller.abort(); await Promise.allSettled([...this.preparations.values()]); await Promise.allSettled([...this.work.values(), ...this.importWork.values(), ...this.mutations.values()]); await Promise.allSettled([...this.writes.values()]); }
}
