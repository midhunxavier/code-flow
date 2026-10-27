import { randomBytes, createHash } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname } from "node:path";
import { realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CODEFLOW_HOME } from "../config.js";
import { readJson, send } from "../http.js";
import { logError } from "../log.js";
import { roleAtLeast } from "../shared-accounts.js";
import type { Pattern } from "../engine.js";
import type { AgentId } from "../adapters/index.js";
import { busyAttempt, CollabError, latestCheckpoint, type CollabActor, type Task } from "./model.js";
import { CollabStore, memberActor, ownerActor, type MemberRecord } from "./store.js";
import { LocalHub } from "./hub-client.js";
import { CollabRunner, type RunnerManager } from "./runner.js";

/** Owner-selected execution, separate from project roles. No member-supplied paths, commands or CLI options. */
export interface HostProjectPolicy {
  projectId: string; enabled: boolean; userIds: string[]; agent: "claude" | "codex" | "agy";
  trust: "safe" | "standard"; maxMinutes: number; maxSteps: number;
}
export type HostJobState = "queued" | "starting" | "running" | "stopping" | "finished" | "failed" | "cancelled" | "interrupted";
export interface HostJob {
  id: string; taskId: string; projectId: string; userId: string; displayName: string;
  state: HostJobState; createdAt: number; endedAt?: number; runId?: string; attemptId?: string; message?: string;
}
interface StoredJob extends HostJob { username: string; policy: HostProjectPolicy; repo: string; contentHash: string }
interface State { version: 1; revision: number; concurrency: number; policies: HostProjectPolicy[]; jobs: StoredJob[] }
export interface HostExecutionOptions {
  store: CollabStore; manager: RunnerManager; findPattern: (id: string) => Pattern | undefined;
  members: () => MemberRecord[]; projectRepos: (id: string) => readonly string[] | undefined;
  resolveRepo: (project: string, repository: string) => string | undefined;
  availableAgents: () => Promise<AgentId[]>; enabled: () => boolean; dir?: string;
}
const active = (job: HostJob) => ["queued", "starting", "running", "stopping"].includes(job.state);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const id = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => { if (Object.keys(v).some((key) => !allowed.includes(key))) throw new CollabError("Unknown host execution field"); };
function policy(value: unknown): HostProjectPolicy {
  if (!object(value)) throw new CollabError("Invalid host execution policy");
  keys(value, ["projectId", "enabled", "userIds", "agent", "trust", "maxMinutes", "maxSteps"]);
  if (!id(value.projectId) || typeof value.enabled !== "boolean" || !Array.isArray(value.userIds) || value.userIds.length > 128 || !value.userIds.every(id) || new Set(value.userIds).size !== value.userIds.length || !["claude", "codex", "agy"].includes(String(value.agent)) || !["safe", "standard"].includes(String(value.trust)) || !integer(value.maxMinutes, 1, 120) || !integer(value.maxSteps, 1, 100)) throw new CollabError("Choose a project, teammates, an installed CLI, permissions, 1–120 minutes and 1–100 steps");
  return structuredClone(value) as unknown as HostProjectPolicy;
}
const taskHash = (task: Task) => createHash("sha256").update(JSON.stringify([task.projectId, task.repository, task.title, task.goal, task.acceptance, task.baseRef, task.owner?.userId, task.decisions, latestCheckpoint(task)?.id])).digest("hex");
function publicJob(job: StoredJob): HostJob {
  const { id, taskId, projectId, userId, displayName, state, createdAt, endedAt, runId, attemptId, message } = job;
  return { id, taskId, projectId, userId, displayName, state, createdAt, endedAt, runId, attemptId, message };
}

/** Durable FIFO admission. Starting is journaled before the runner can execute; recovery never starts it twice. */
export class HostExecution {
  private state: State = { version: 1, revision: 0, concurrency: 1, policies: [], jobs: [] };
  private ready = false; private closed = false; private chain: Promise<unknown> = Promise.resolve();
  private runners = new Map<string, CollabRunner>(); private timer?: NodeJS.Timeout;
  private readonly dir: string; private readonly file: string;
  constructor(private readonly options: HostExecutionOptions) { this.dir = options.dir ?? join(CODEFLOW_HOME, "host-execution"); this.file = join(this.dir, "queue.json"); }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const next = this.chain.catch(() => undefined).then(fn); this.chain = next; return next; }
  private require() { if (!this.ready || this.closed) throw new CollabError("Host execution is unavailable", 503); }
  async load(): Promise<void> {
    if (this.ready) return;
    try {
      const handle = await open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let value: unknown;
      try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("Invalid queue storage"); value = JSON.parse(await handle.readFile("utf8")); } finally { await handle.close(); }
      if (!object(value) || value.version !== 1 || !integer(value.revision, 0, Number.MAX_SAFE_INTEGER) || !integer(value.concurrency, 1, 4) || !Array.isArray(value.policies) || value.policies.length > 200 || !Array.isArray(value.jobs) || value.jobs.length > 250) throw new Error("Invalid queue storage");
      value.policies.forEach(policy);
      for (const j of value.jobs) {
        if (!object(j) || typeof j.id !== "string" || !/^h-[a-f0-9]{16}$/.test(j.id) || !id(j.taskId) || !id(j.projectId) || !id(j.userId) || typeof j.username !== "string" || typeof j.displayName !== "string" || typeof j.repo !== "string" || typeof j.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(j.contentHash) || !integer(j.createdAt, 0, Number.MAX_SAFE_INTEGER) || !["queued", "starting", "running", "stopping", "finished", "failed", "cancelled", "interrupted"].includes(String(j.state)) || j.runId !== undefined && !id(j.runId) || j.attemptId !== undefined && (typeof j.attemptId !== "string" || !/^[a-f0-9]{32}$/.test(j.attemptId))) throw new Error("Invalid queue job");
        const p = policy(j.policy); if (p.projectId !== j.projectId || !p.userIds.includes(j.userId)) throw new Error("Invalid queue grant");
      }
      if (new Set(value.jobs.map((j) => j.id)).size !== value.jobs.length || new Set(value.policies.map((p) => p.projectId)).size !== value.policies.length) throw new Error("Duplicate queue records");
      this.state = value as unknown as State;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.ready = true;
    try {
    for (const job of this.state.jobs.filter((j) => active(j) && j.state !== "queued")) {
      const runner = this.runner(job); await runner.reconcile();
      const record = await runner.attemptForTask(job.taskId);
      if (record?.runId) { job.runId = record.runId; job.attemptId = record.attemptId; if (job.state !== "stopping") job.state = "running"; }
      else { job.state = "interrupted"; job.message = "Start interrupted. Review the task attempt before queuing it again."; job.endedAt = Date.now(); }
    }
    await this.persist();
    } catch (error) { this.ready = false; await Promise.all([...this.runners.values()].map((runner) => runner.close())); throw error; }
  }
  start() { if (this.timer) return; this.timer = setInterval(() => void this.tick().catch((error) => logError("Host execution queue failed", error)), 2000); this.timer.unref(); }
  private async persist() {
    const retained = new Set(this.state.jobs.filter((job) => !active(job)).slice(-200).map((job) => job.id));
    this.state.jobs = this.state.jobs.filter((job) => active(job) || retained.has(job.id));
    const temp = `${this.file}.${randomBytes(8).toString("hex")}.tmp`;
    try { await mkdir(dirname(this.file), { recursive: true, mode: 0o700 }); const handle = await open(temp, "wx", 0o600); try { await handle.writeFile(JSON.stringify(this.state)); await handle.sync(); } finally { await handle.close(); } await rename(temp, this.file); if (process.platform !== "win32") { const folder = await open(dirname(this.file), "r"); try { await folder.sync(); } finally { await folder.close(); } } }
    catch (error) { this.ready = false; for (const job of this.state.jobs) if (active(job) && job.runId) this.options.manager.cancel(job.runId); throw error; }
    finally { await rm(temp, { force: true }).catch(() => {}); }
  }
  private changed(job?: HostJob) { this.options.store.hostExecutionChanged(job?.projectId, job?.taskId); }
  view(actor: CollabActor) {
    this.require(); const owner = actor.kind === "owner";
    const member = owner ? undefined : this.options.members().find((m) => m.userId === actor.userId && m.enabled);
    const visible = (p: string) => !!this.options.projectRepos(p) && (owner || !!member?.roles[p]);
    const jobs = this.state.jobs.filter((j) => visible(j.projectId)).map(publicJob);
    const policies = this.state.policies.filter((p) => visible(p.projectId));
    return { revision: this.state.revision, concurrency: this.state.concurrency, available: this.options.enabled(),
      policies: owner ? structuredClone(policies) : policies.map((p) => ({ projectId: p.projectId, agent: p.agent, allowed: p.enabled && p.userIds.includes(actor.userId) && roleAtLeast(member?.roles[p.projectId], "contributor") })), jobs };
  }
  configure(raw: Record<string, unknown>) { return this.serial(async () => {
    this.require(); keys(raw, ["revision", "concurrency", "policy"]);
    if (raw.revision !== this.state.revision) throw new CollabError("Host settings changed; reload before saving", 409);
    if (raw.concurrency !== undefined) { if (!integer(raw.concurrency, 1, 4)) throw new CollabError("Choose 1–4 concurrent host tasks"); }
    let next: HostProjectPolicy | undefined;
    if (raw.policy !== undefined) {
      next = policy(raw.policy); if (!this.options.projectRepos(next.projectId)) throw new CollabError("Project not found", 404);
      if (!this.state.policies.some((p) => p.projectId === next!.projectId) && this.state.policies.length >= 200) throw new CollabError("At most 200 project execution policies may be configured");
      if (next.userIds.some((uid) => !this.options.members().some((m) => m.userId === uid && m.enabled && roleAtLeast(m.roles[next!.projectId], "contributor")))) throw new CollabError("Grant execution only to enabled project contributors or maintainers");
      if (next.enabled && !(await this.options.availableAgents()).includes(next.agent)) throw new CollabError("This CLI is not installed on the host");
    }
    if (next) this.state.policies = [...this.state.policies.filter((p) => p.projectId !== next.projectId), next];
    if (raw.concurrency !== undefined) this.state.concurrency = raw.concurrency as number;
    this.state.revision++; await this.persist(); this.changed(); return this.view(ownerActor());
  }); }
  removeAccount(userId: string) { return this.serial(async () => {
    this.require(); let changed = false;
    for (const policy of this.state.policies) if (policy.userIds.includes(userId)) { policy.userIds = policy.userIds.filter(id => id !== userId); changed = true; }
    const stopping: string[] = [];
    for (const job of this.state.jobs) if (job.userId === userId && active(job)) {
      if (job.state === "queued") { job.state = "cancelled"; job.endedAt = Date.now(); }
      else { job.state = "stopping"; if (job.runId) stopping.push(job.runId); }
      job.message = "Account deleted by the owner"; changed = true;
    }
    if (changed) { this.state.revision++; await this.persist(); for (const id of stopping) this.options.manager.cancel(id); this.changed(); }
  }); }
  private async authorize(job: StoredJob): Promise<Task> {
    this.require();
    if (!this.options.enabled()) throw new CollabError("Host execution is disabled or unavailable", 403);
    const member = this.options.members().find((m) => m.userId === job.userId && m.enabled);
    const p = this.state.policies.find((p) => p.projectId === job.projectId);
    if (!member || !roleAtLeast(member.roles[job.projectId], "contributor") || !p?.enabled || !p.userIds.includes(job.userId) || JSON.stringify(p) !== JSON.stringify(job.policy)) throw new CollabError("Host execution permission or settings changed; ask the owner and queue again", 403);
    const task = await this.options.store.task(memberActor(member, "browser"), job.taskId);
    if (task.owner?.userId !== job.userId || taskHash(task) !== job.contentHash) throw new CollabError("Task changed while queued; review it and queue again", 409);
    const mapped = this.options.resolveRepo(task.projectId, task.repository);
    const repos = this.options.projectRepos(task.projectId);
    if (!mapped || mapped !== job.repo || !repos?.includes(mapped) || await realpath(mapped) !== mapped) throw new CollabError("The host repository mapping is unavailable or changed", 409);
    return task;
  }
  enqueue(actor: CollabActor, taskId: string, raw: Record<string, unknown>) { return this.serial(async () => {
    this.require(); keys(raw, ["revision"]);
    if (actor.kind !== "member" || actor.via !== "browser") throw new CollabError("Sign in with your teammate account to queue a host task", 403);
    const member = this.options.members().find((m) => m.userId === actor.userId && m.enabled);
    if (!member) throw new CollabError("Account unavailable", 403);
    const task = await this.options.store.task(memberActor(member, "browser"), taskId);
    if (task.owner?.userId !== member.userId) throw new CollabError("Only the task owner can queue it on the team server; take ownership first", 409);
    const currentPolicy = this.state.policies.find(policy => policy.projectId === task.projectId);
    if (!this.options.enabled() || !roleAtLeast(member.roles[task.projectId], "contributor") || !currentPolicy?.enabled || !currentPolicy.userIds.includes(member.userId)) throw new CollabError("Host execution permission is unavailable; ask the owner for access", 403);
    // A started claim changes the task revision and busy state. Repeated requests still refer to
    // this requester's existing work, after rechecking current ownership and execution permission.
    const duplicate = this.state.jobs.find(job => active(job) && job.taskId === taskId && job.userId === member.userId);
    if (duplicate) return publicJob(duplicate);
    if (raw.revision !== task.revision) throw new CollabError("Task changed; reload before queuing", 409);
    const p = this.state.policies.find((p) => p.projectId === task.projectId);
    if (!p) throw new CollabError("The owner has not enabled host execution for this project", 403);
    const job: StoredJob = { id: `h-${randomBytes(8).toString("hex")}`, taskId, projectId: task.projectId, userId: member.userId, username: member.username, displayName: member.displayName, state: "queued", createdAt: Date.now(), policy: structuredClone(p), repo: this.options.resolveRepo(task.projectId, task.repository) ?? "", contentHash: taskHash(task) };
    await this.authorize(job);
    if (task.status === "done" || busyAttempt(task) || task.handoff?.state === "offered") throw new CollabError("This task cannot start while done, executing or being handed over", 409);
    if (this.state.jobs.filter(active).length >= 50) throw new CollabError("The host queue is full (50 tasks)", 409);
    this.state.jobs = [...this.state.jobs.filter(active), ...this.state.jobs.filter((j) => !active(j)).slice(-199)].sort((a, b) => a.createdAt - b.createdAt);
    this.state.jobs.push(job); await this.persist(); this.changed(job); return publicJob(job);
  }); }
  cancel(actor: CollabActor, jobId: string) { return this.serial(async () => {
    this.require(); const visible = this.view(actor).jobs.find((j) => j.id === jobId);
    if (!visible) throw new CollabError("Host task not found", 404);
    if (actor.kind !== "owner" && visible.userId !== actor.userId) throw new CollabError("Only the requester or host owner may cancel this task", 403);
    const job = this.state.jobs.find((j) => j.id === jobId)!;
    if (!active(job)) return publicJob(job);
    if (job.state === "queued") { job.state = "cancelled"; job.endedAt = Date.now(); }
    else { job.state = "stopping"; }
    await this.persist(); if (job.runId && job.state === "stopping") this.options.manager.cancel(job.runId);
    this.changed(job); return publicJob(job);
  }); }
  private runner(job: StoredJob) {
    let runner = this.runners.get(job.id); if (runner) return runner;
    // In-process identity only: no bearer credential is created or exposed to the browser.
    // Its narrow retained project role permits reporting/cleanup after a grant is revoked.
    const actor = memberActor({ userId: job.userId, username: job.username, displayName: job.displayName, enabled: true, roles: { [job.projectId]: "contributor" } }, "runner", `r-${job.id.slice(2)}`);
    const hub = new LocalHub(this.options.store, actor, { runnerId: actor.kind === "member" ? actor.runnerId : undefined, runnerName: "Host computer" });
    runner = new CollabRunner({ manager: this.options.manager, findPattern: this.options.findPattern, hub: () => hub, dir: join(this.dir, job.id), projectFor: () => job.projectId, beforeStart: async () => { await this.authorize(job); } });
    this.runners.set(job.id, runner); return runner;
  }
  tick() { return this.serial(async () => {
    this.require();
    for (const job of this.state.jobs.filter((j) => active(j) && j.state !== "queued")) {
      const runner = this.runner(job), run = job.runId ? this.options.manager.get(job.runId) : undefined;
      if (run?.status === "running") {
        // Role/account revocation and policy changes stop already-running jobs, too.
        if (job.state !== "stopping") { try { await this.authorize(job); } catch { job.state = "stopping"; job.message = "Stopped because execution permission, task or repository changed."; await this.persist(); this.changed(job); } }
        if (job.state === "stopping") this.options.manager.cancel(run.id);
        continue;
      }
      await runner.reconcile(); const record = await runner.attemptForTask(job.taskId);
      if (record?.pendingFinish) continue; // Do not release capacity before the checkpoint/finish is durable.
      job.state = job.state === "stopping" ? record?.state === "failed" ? "failed" : "cancelled" : run?.status === "done" ? "finished" : run?.status === "interrupted" || !run ? "interrupted" : "failed";
      job.endedAt = Date.now(); await this.persist(); this.changed(job); await runner.close(); this.runners.delete(job.id);
    }
    while (this.state.jobs.filter((j) => active(j) && j.state !== "queued").length < this.state.concurrency) {
      const job = this.state.jobs.find((j) => j.state === "queued"); if (!job) break;
      try {
        const task = await this.authorize(job);
        if (!(await this.options.availableAgents()).includes(job.policy.agent)) throw new CollabError("The configured CLI is unavailable on the host");
        job.state = "starting"; await this.persist(); this.changed(job);
        const checkpoint = latestCheckpoint(task);
        const started = await this.runner(job).startAttempt(task.id, { repo: job.repo, pattern: "solo", roles: { agent: [job.policy.agent] }, trust: job.policy.trust, loop: { maxMinutes: job.policy.maxMinutes, maxSteps: job.policy.maxSteps }, ...(checkpoint ? { fromCheckpointId: checkpoint.id } : {}) });
        Object.assign(job, started); job.state = "running"; await this.persist(); this.changed(job);
      } catch (error) {
        if (!this.ready) throw error;
        // A journal may exist even if the start response was lost. Reconcile it before allowing another run.
        const runner = this.runners.get(job.id), record = await runner?.attemptForTask(job.taskId);
        if (record?.runId || record?.pendingFinish) { job.runId = record.runId; job.attemptId = record.attemptId; job.state = "stopping"; if (record.runId) this.options.manager.cancel(record.runId); }
        else { job.state = "failed"; job.endedAt = Date.now(); }
        job.message = error instanceof CollabError && !record ? error.message : "The host could not start this task. Ask the owner to check its execution log.";
        logError(`Host task ${job.id} could not start`, error); await this.persist(); this.changed(job);
        if (runner && !record?.pendingFinish && !record?.runId) { await runner.close(); this.runners.delete(job.id); }
      }
    }
  }); }
  async close() { this.closed = true; if (this.timer) clearInterval(this.timer); await this.chain.catch(() => {}); await Promise.all([...this.runners.values()].map((runner) => runner.close())); }
}

/** Exact routes; shared callers never reach settings or generic run/terminal handlers. */
export async function handleHostExecution(req: IncomingMessage, res: ServerResponse, parts: readonly string[], queue: HostExecution, actor: CollabActor, mutation: () => void) {
  try {
    const method = req.method ?? "GET";
    if (parts.length === 2 && method === "GET") return send(res, 200, queue.view(actor));
    if (method !== "GET") mutation();
    if (parts.length === 3 && parts[2] === "settings" && method === "PUT") {
      if (actor.kind !== "owner") throw new CollabError("Only the host owner may grant execution", 403);
      return send(res, 200, await queue.configure(await readJson(req, 32 * 1024, { timeoutMs: 10_000 })));
    }
    if (parts.length === 4 && parts[2] === "tasks" && method === "POST") return send(res, 202, await queue.enqueue(actor, parts[3]!, await readJson(req, 1024, { timeoutMs: 10_000 })));
    if (parts.length === 5 && parts[2] === "jobs" && parts[4] === "cancel" && method === "POST") { const raw = await readJson(req, 1024, { timeoutMs: 10_000 }); keys(raw, []); return send(res, 200, await queue.cancel(actor, parts[3]!)); }
    throw new CollabError("Unknown host execution operation", 404);
  } catch (error) { if (error instanceof CollabError) return send(res, error.status, { error: error.message }); throw error; }
}
