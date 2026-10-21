import { resolveRunPermissions } from "../run-permissions.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { getAdapter } from "../adapters/index.js";
import type { AgentEvent, AgentId, RunResult } from "../adapters/types.js";
import { validateAgentContainer, type AgentContainer } from "../agent-container.js";
import { ensureCodeflowExcludes, git, resolveCommit } from "../git.js";
import { redactExport } from "../privacy.js";
import { verificationIntegrity } from "../verification-integrity.js";
import { registerPrivateEnvNames } from "../env.js";
import { assertTransferTree, boundedBundle, disabledCheckoutFilters, gitChecked, sha256, writeContext } from "./bundles.js";
import { CAPABILITY, MAX_EVENTS_BYTES, REQUEST_ID, RemoteWorkerError, validateWorkerRequest, type WorkerArtifact, type WorkerCapabilities, type WorkerReceipt, type WorkerRequest } from "./protocol.js";
import { durableWorkerDirectory } from "./durability.js";

export interface WorkerConfig { version: 1; root: string; repos: Record<string, string>; providers: AgentId[]; allowedTrust: Array<"safe" | "standard" | "trusted" | "full">; containers: Record<string, AgentContainer> }
interface SavedReceipt extends WorkerReceipt { capabilityHash: string; pid?: number }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const hashCapability = (value: string) => createHash("sha256").update(value).digest();
export async function loadWorkerConfig(path: string): Promise<WorkerConfig> {
  registerPrivateEnvNames(["CODEFLOW_WORKER_CONFIG_FILE", "CODEFLOW_REMOTE_WORKERS_FILE", "CODEFLOW_REMOTE_WORKERS_JSON"]);
  if (!isAbsolute(path)) throw new RemoteWorkerError("Worker configuration path must be absolute");
  const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) throw new RemoteWorkerError("Worker configuration must be a regular file under 128 KiB");
  const raw = JSON.parse(await readFile(path, "utf8"));
  if (!object(raw) || raw.version !== 1 || typeof raw.root !== "string" || !isAbsolute(raw.root) || !object(raw.repos) || Object.keys(raw.repos).length > 20 || !Array.isArray(raw.providers) || !raw.providers.length || raw.providers.some((id) => !["claude", "codex", "agy"].includes(id))) throw new RemoteWorkerError("Invalid explicitly provisioned worker configuration");
  const repos: Record<string, string> = Object.create(null);
  for (const [id, path] of Object.entries(raw.repos)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || typeof path !== "string" || !isAbsolute(path) || !(await lstat(path)).isDirectory()) throw new RemoteWorkerError("Worker repository mappings need regular, existing absolute Git directories");
    repos[id] = await realpath(path); await resolveCommit(repos[id]!);
  }
  const allowedTrust = raw.allowedTrust ?? ["safe", "standard"];
  if (!Array.isArray(allowedTrust) || !allowedTrust.length || allowedTrust.some((value) => !["safe", "standard", "trusted", "full"].includes(value))) throw new RemoteWorkerError("Invalid worker permission policy");
  if (raw.containers !== undefined && (!object(raw.containers) || Object.keys(raw.containers).length > 20)) throw new RemoteWorkerError("Worker containers must be at most 20 explicit named profiles");
  const containers: Record<string, AgentContainer> = Object.create(null);
  for (const [id, value] of Object.entries(raw.containers ?? {})) { if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new RemoteWorkerError("Invalid worker container profile ID"); containers[id] = validateAgentContainer(value); }
  await durableWorkerDirectory(raw.root);
  if (!(await lstat(raw.root)).isDirectory()) throw new RemoteWorkerError("Worker root must be a regular directory");
  return { version: 1, root: await realpath(raw.root), repos, providers: [...new Set(raw.providers)] as AgentId[], allowedTrust: allowedTrust as WorkerConfig["allowedTrust"], containers };
}
export class ProvisionedWorker {
  private readonly controllers = new Map<string, AbortController>();
  constructor(readonly config: WorkerConfig) {}
  private async providerAvailable(id: AgentId, profile?: string) {
    if (!profile) return getAdapter(id).available();
    if (!Object.hasOwn(this.config.containers, profile)) throw new RemoteWorkerError("Choose an explicit worker-local container profile");
    const container = this.config.containers[profile]!, name = `codeflow-probe-${randomBytes(8).toString("hex")}`;
    const invoke = (args: string[], timeout: number) => new Promise<boolean>((done) => execFile("docker", args, { timeout, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }, (error) => done(!error)));
    try { return await invoke(["run", "--rm", "--pull=never", "--name", name, "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--entrypoint", getAdapter(id).binary, container.image, "--version"], 10_000); }
    finally { await invoke(["rm", "-f", name], 5_000); }
  }
  async capabilities(containerProfile?: string, discoverModels = false): Promise<WorkerCapabilities> {
    if (containerProfile !== undefined && (!/^[a-z][a-z0-9-]{0,63}$/.test(containerProfile) || !Object.hasOwn(this.config.containers, containerProfile))) throw new RemoteWorkerError("Choose an explicit worker-local container profile");
    return { protocol: 1, providers: await Promise.all(this.config.providers.map(async (id) => ({ id, available: await this.providerAvailable(id, containerProfile), modelCatalog: discoverModels ? await getAdapter(id).discoverModels?.({cwd:this.config.root, agentContainer:containerProfile?this.config.containers[containerProfile]:undefined}).catch(()=>undefined) : undefined }))), repoMappings: Object.keys(this.config.repos), containerProfiles: Object.keys(this.config.containers), resumeSessions: false, liveTeamTools: false, interactiveApprovals: false, stagedContext: true, maximumBundleBytes: 64 * 1024 * 1024, maximumContextBytes: 16 * 1024 * 1024 };
  }
  repo(id: string) { const path = Object.hasOwn(this.config.repos, id) ? this.config.repos[id] : undefined; if (!path) throw new RemoteWorkerError("Choose an explicitly provisioned worker repository mapping"); return path; }
  private directory(id: string) { if (!REQUEST_ID.test(id)) throw new RemoteWorkerError("Invalid worker request identity"); return join(this.config.root, "requests", id); }
  private async save(receipt: SavedReceipt) {
    const folder = this.directory(receipt.requestId), temp = join(folder, `receipt-${randomBytes(8).toString("hex")}.tmp`);
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temp, join(folder, "receipt.json")); await this.syncDirectory(folder); } finally { await rm(temp, { force: true }); }
  }
  private async syncDirectory(path: string) { const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); } }
  private async acquireSlot(id: string) {
    const root = join(this.config.root, "slots"); await mkdir(root, { recursive: true, mode: 0o700 });
    for (let slot = 0; slot < 4; slot++) {
      const file = join(root, String(slot)); let handle;
      try { handle = await open(file, "wx", 0o600); await handle.writeFile(JSON.stringify({ id, pid: process.pid })); await handle.sync(); return async () => { await rm(file, { force: true }); }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      finally { await handle?.close(); }
    }
    throw new RemoteWorkerError("Worker has four active or unresolved execution slots. Inspect stale worker processes before removing their slot files.");
  }
  private publicReceipt(receipt: SavedReceipt): WorkerReceipt { const { capabilityHash: _hash, pid: _pid, ...value } = receipt; return redactExport(value); }
  async receipt(id: string, capability: string): Promise<WorkerReceipt> {
    if (!CAPABILITY.test(capability)) throw new RemoteWorkerError("Invalid worker request capability");
    const file = join(this.directory(id), "receipt.json"), info = await lstat(file).catch(() => undefined);
    if (!info) return { version: 1, requestId: id, state: "unknown", reason: "No durable receipt is available. Do not automatically repeat this execution." };
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new RemoteWorkerError("Worker receipt is damaged");
    const saved = JSON.parse(await readFile(file, "utf8")) as SavedReceipt;
    if (saved.version !== 1 || saved.requestId !== id || !/^[a-f0-9]{64}$/.test(saved.capabilityHash) || !timingSafeEqual(Buffer.from(saved.capabilityHash, "hex"), hashCapability(capability))) throw new RemoteWorkerError("This capability does not own the worker receipt");
    const value = this.publicReceipt(saved);
    if (["accepted", "running"].includes(value.state) && Date.now() - (value.heartbeatAt ?? value.updatedAt ?? 0) > 15_000) { value.state = "unknown"; value.reason = "Worker heartbeat expired; the execution outcome is ambiguous. Inspect or cancel it before explicitly retrying."; }
    return value;
  }
  async cancel(id: string, capability: string) {
    const receipt = await this.receipt(id, capability);
    if (["completed", "failed", "cancelled"].includes(receipt.state)) return receipt;
    if (!receipt.createdAt) return { ...receipt, reason: "No execution receipt was found; nothing was cancelled. Do not automatically repeat an ambiguous request." };
    await writeFile(join(this.directory(id), "cancel"), "cancel\n", { flag: "w", mode: 0o600 }); this.controllers.get(id)?.abort(); return receipt;
  }
  private async capacity() {
    const root = join(this.config.root, "requests"); await durableWorkerDirectory(root);
    const entries = await readdir(root);
    if (entries.length >= 100) throw new RemoteWorkerError("Worker keeps at most 100 request receipts. Archive inspected terminal request directories before accepting more work.");
  }
  /** The exclusive receipt lock is acquired before any provider launches and is never reused. */
  async execute(raw: WorkerRequest, source: Uint8Array | undefined, context: Map<string, Uint8Array>, emit: (event: AgentEvent) => void, heartbeat: (receipt: WorkerReceipt) => void, signal?: AbortSignal): Promise<{ receipt: WorkerReceipt; result: RunResult; artifact?: WorkerArtifact & { file: string } }> {
    const request = validateWorkerRequest(raw), repo = this.repo(request.repoMapping);
    const fingerprint = sha256(JSON.stringify({ ...request, capability: undefined, source: undefined }));
    if (!this.config.providers.includes(request.agent) || !await this.providerAvailable(request.agent, request.containerProfile)) throw new RemoteWorkerError("The selected official CLI is unavailable in this worker execution profile");
    if (!this.config.allowedTrust.includes(request.trust)) throw new RemoteWorkerError("The requested permission level is outside this worker's explicit policy");
    if (request.containerProfile && !Object.hasOwn(this.config.containers, request.containerProfile)) throw new RemoteWorkerError("Choose an explicit worker-local container profile; host credential volumes are never forwarded");
    await this.capacity(); const folder = this.directory(request.id); await mkdir(folder, { recursive: true, mode: 0o700 });
    let lock;
    try { lock = await open(join(folder, "execution.lock"), "wx", 0o600); await lock.writeFile(request.id); await lock.sync(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; const receipt = await this.receipt(request.id, request.capability); if (receipt.fingerprint && receipt.fingerprint !== fingerprint) throw new RemoteWorkerError("This request identity belongs to a different scoped execution"); return { receipt, result: receipt.result ?? { ok: false, finalText: "", error: "This request was already accepted; inspect its receipt instead of duplicating it", errorKind: "other" } }; }
    finally { await lock?.close(); }
    const saved: SavedReceipt = { version: 1, requestId: request.id, state: "accepted", fingerprint, capabilityHash: hashCapability(request.capability).toString("hex"), createdAt: Date.now(), updatedAt: Date.now(), heartbeatAt: Date.now(), pid: process.pid };
    await this.syncDirectory(folder); await this.syncDirectory(join(this.config.root, "requests"));
    await this.save(saved); heartbeat(this.publicReceipt(saved));
    const controller = new AbortController(); this.controllers.set(request.id, controller);
    const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    const timeout = setTimeout(abort, request.timeoutMs); timeout.unref();
    let ticking = false, eventsBytes = 0, artifact: (WorkerArtifact & { file: string }) | undefined;
    const tick = setInterval(() => { if (ticking) return; ticking = true; void (async () => { if (await lstat(join(folder, "cancel")).then(() => true, () => false)) controller.abort(); saved.heartbeatAt = Date.now(); saved.updatedAt = Date.now(); await this.save(saved); heartbeat(this.publicReceipt(saved)); })().catch(abort).finally(() => { ticking = false; }); }, 2_000); tick.unref();
    const checkout = join(folder, "checkout"), importRef = `refs/codeflow/imports/${request.id}`; let imported = false, attached = false; let releaseSlot: (() => Promise<void>) | undefined;
    let result: RunResult = { ok: false, finalText: "", error: "Remote execution did not complete", errorKind: "other" };
    try {
      releaseSlot = await this.acquireSlot(request.id);
      if (request.source) {
        if (!source || source.length !== request.source.size || sha256(source) !== request.source.sha256) throw new RemoteWorkerError("Uploaded source bundle failed its manifest");
        const file = join(folder, "source.bundle"); await writeFile(file, source, { flag: "wx", mode: 0o600 });
        if (await gitChecked(repo, ["bundle", "list-heads", file]) !== `${request.baseCommit} ${request.source.ref}`) throw new RemoteWorkerError("Source bundle has unexpected references");
        await gitChecked(repo, ["bundle", "verify", file]);
        if (!(await git(["show-ref", "--verify", "--quiet", importRef], repo)).code) throw new RemoteWorkerError("Worker import identity is already claimed");
        await gitChecked(repo, ["fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", file, `${request.source.ref}:${importRef}`]); imported = true;
      }
      if (await resolveCommit(repo, request.baseCommit) !== request.baseCommit) throw new RemoteWorkerError("The provisioned mapping lacks the exact requested commit");
      await assertTransferTree(repo, request.baseCommit); const filters = await disabledCheckoutFilters(repo);
      await ensureCodeflowExcludes(repo);
      await gitChecked(repo, [...filters, "worktree", "add", "--detach", checkout, request.baseCommit]); attached = true;
      for (const file of request.context) { const data = context.get(file.path); if (!data || data.length !== file.size || sha256(data) !== file.sha256) throw new RemoteWorkerError("Uploaded context failed its manifest"); await writeContext(checkout, file.path, data); }
      const integrity = await verificationIntegrity(checkout, controller.signal);
      saved.state = "running"; saved.updatedAt = Date.now(); await this.save(saved); heartbeat(this.publicReceipt(saved));
      if (controller.signal.aborted || await lstat(join(folder, "cancel")).then(() => true, () => false)) { controller.abort(); throw new RemoteWorkerError("Remote execution was cancelled before invoking its provider"); }
      const permissions = request.managedPermissions ? resolveRunPermissions({ policy: request.managedPermissions, provider: request.agent, mode: request.mode, currentTrust: request.trust, currentTools: request.managedPermissions.toolApprovals, unattended: true, container: !!request.containerProfile }) : undefined;
      result = await getAdapter(request.agent).run({ permissions, cwd: checkout, prompt: request.prompt, mode: request.mode, model: request.model, effort: request.effort, trust: permissions?.trust ?? request.trust, interactiveApprovals: permissions?.toolApprovals ?? false, timeoutMs: request.timeoutMs, idleTimeoutMs: request.idleTimeoutMs, signal: controller.signal, jsonSchema: request.jsonSchema, questionProtocol: request.questionProtocol, ...(request.containerProfile ? { agentContainer: this.config.containers[request.containerProfile] } : {}) }, (event) => {
        if (event.kind === "session") return; // Worker sessions cannot be resumed across request-scoped worktrees.
        const data = redactExport(event), bytes = Buffer.byteLength(JSON.stringify(data)); eventsBytes += bytes;
        if (bytes > 256 * 1024 || eventsBytes > MAX_EVENTS_BYTES) { controller.abort(); return; } emit(data);
      });
      result = redactExport({ ...result, sessionId: undefined, finalText: result.finalText.slice(0, 512 * 1024) });
      if (JSON.stringify(result).length > 1024 * 1024) result = { ok: false, finalText: "", error: "Worker result exceeded its bounded response", errorKind: "other" };
      if (request.mode === "read") {
        await integrity.assert("read-only agent turn");
        if ((await git(["status", "--porcelain", "--untracked-files=all"], checkout)).stdout.trim()) throw new RemoteWorkerError("The read-only worker turn modified its checkout; its changes were discarded");
      } else {
        if (await resolveCommit(checkout) !== request.baseCommit) throw new RemoteWorkerError("The agent changed checkout history instead of returning work for its scoped commit");
        await gitChecked(checkout, [...await disabledCheckoutFilters(checkout), "add", "--all", "--", "."]);
        const changed = await git(["diff", "--cached", "--quiet", "--exit-code"], checkout);
        if (changed.code > 1) throw new RemoteWorkerError("Cannot inspect remote staged changes");
        if (changed.code === 1) {
          await assertTransferTree(checkout, await gitChecked(checkout, ["write-tree"]));
          await gitChecked(checkout, [...await disabledCheckoutFilters(checkout), "-c", "user.name=code-flow worker", "-c", "user.email=worker@code-flow.invalid", "commit", "-m", `Remote request ${request.id}`]);
          const head = await resolveCommit(checkout);
          await assertTransferTree(checkout, head);
          const ref = `refs/codeflow/results/${request.id}`, file = join(folder, "result.bundle");
          // Recreate with the dedicated result reference; temporary refs are CAS-owned and removed.
          await gitChecked(checkout, ["update-ref", ref, head, "0".repeat(head.length)]);
          let data: Buffer;
          try { data = await boundedBundle(checkout, file, [ref, `^${request.baseCommit}`]); } finally { await gitChecked(checkout, ["update-ref", "-d", ref, head]); }
          artifact = { requestId: request.id, baseCommit: request.baseCommit, head, size: data.length, sha256: sha256(data), ref, file };
        }
      }
      if (controller.signal.aborted) result = { ok: false, finalText: result.finalText, error: "Remote execution was cancelled or exceeded its deadline", errorKind: "cancelled" };
    } catch (error) { result = { ok: false, finalText: result.finalText, error: redactExport((error as Error).message).slice(0, 2000), errorKind: controller.signal.aborted ? "cancelled" : "other" }; }
    finally {
      clearTimeout(timeout); clearInterval(tick); signal?.removeEventListener("abort", abort); this.controllers.delete(request.id);
      while (ticking) await new Promise((resolve) => setTimeout(resolve, 10));
      if (attached) await gitChecked(repo, ["worktree", "remove", "--force", checkout]).catch(() => undefined);
      if (imported) await gitChecked(repo, ["update-ref", "-d", importRef, request.baseCommit]).catch(() => undefined);
      await rm(checkout, { recursive: true, force: true }); await releaseSlot?.();
    }
    if (controller.signal.aborted) { artifact = undefined; await rm(join(folder, "result.bundle"), { force: true }); }
    saved.state = controller.signal.aborted ? "cancelled" : result.ok ? "completed" : "failed"; saved.result = result; saved.updatedAt = Date.now(); saved.heartbeatAt = Date.now();
    if (artifact) { const { file: _file, ...manifest } = artifact; saved.artifact = manifest; }
    await this.save(saved); return { receipt: this.publicReceipt(saved), result, artifact };
  }
}
