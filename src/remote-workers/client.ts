import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentEvent, RunOptions, RunResult } from "../adapters/types.js";
import { resolveCommit } from "../git.js";
import { registerPrivateEnvNames } from "../env.js";
import { durableWorkerDirectory } from "./durability.js";
import { redactExport } from "../privacy.js";
import { verificationIntegrity } from "../verification-integrity.js";
import { assertTransferTree, chunks, contextManifest, importWorkerArtifact, sha256, sourceBundle } from "./bundles.js";
import { CAPABILITY, COMMIT_ID, DIGEST, MAX_BUNDLE_BYTES, MAX_EVENTS_BYTES, MAX_FRAME_BYTES, REQUEST_ID, RemoteWorkerError, validateWorkerCapabilities, validateWorkerRequest, type ClientFrame, type ReceiptState, type WorkerArtifact, type WorkerCapabilities, type WorkerFrame, type WorkerReceipt, type WorkerRequest, type WorkerTarget } from "./protocol.js";

export interface RemoteRunResult extends RunResult {
  remote: { workerId: string; requestId: string; state: ReceiptState; receipt?: string; ambiguous?: boolean; baseCommit: string; resultHead?: string };
  /** Local bounded spool. Never serialize this path as agent evidence. */
  artifact?: WorkerArtifact & { file: string };
}
interface PrivateRequest { version: 1; workerId: string; requestId: string; capability: string; scope: WorkerRequest["scope"]; baseCommit: string; fingerprint: string; targetFingerprint: string; createdAt: number }
const targetFingerprint = (target: WorkerTarget) => sha256(JSON.stringify({ sshHost: target.sshHost, command: target.command, containerProfile: target.containerProfile }));
type Probe = { capabilities: WorkerCapabilities; hasBase?: boolean; hasRepositoryBase?: boolean };
type Exchange = { receipt?: WorkerReceipt; result?: RunResult; probe?: Probe; artifact?: WorkerArtifact; bytes?: Buffer };
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const terminal = (state: ReceiptState) => ["completed", "failed", "cancelled"].includes(state);
export const SSH_OPTIONS = ["-T", "-a", "-k", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no", "-o", "RemoteCommand=none", "-o", "GSSAPIDelegateCredentials=no", "-o", "SendEnv=-*", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ConnectTimeout=10"];

/** SSH gets local identity discovery only. Application/provider credentials and environment are never forwarded. */
function sshEnvironment(): NodeJS.ProcessEnv { return { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME, SYSTEMROOT: process.env.SYSTEMROOT, LANG: "C.UTF-8" }; }
function targetConfig(value: unknown): WorkerTarget[] {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.workers) || value.workers.length > 20) throw new RemoteWorkerError("Remote workers need explicit version 1 configuration with at most 20 targets");
  const workers = value.workers.map((raw): WorkerTarget => {
    if (!object(raw) || typeof raw.id !== "string" || !ID.test(raw.id) || typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 120 || typeof raw.sshHost !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,199}$/.test(raw.sshHost) || typeof raw.command !== "string" || !raw.command.trim() || raw.command.length > 2000 || /[\r\n\0]/.test(raw.command) || !Array.isArray(raw.repoMappings) || !raw.repoMappings.length || raw.repoMappings.length > 20 || raw.repoMappings.some((id) => typeof id !== "string" || !ID.test(id)) || raw.containerProfile !== undefined && (typeof raw.containerProfile !== "string" || !ID.test(raw.containerProfile))) throw new RemoteWorkerError("Invalid registered SSH worker, command or repository mapping");
    return { id: raw.id, name: raw.name.trim(), sshHost: raw.sshHost, command: raw.command, repoMappings: [...new Set(raw.repoMappings)] as string[], ...(raw.containerProfile ? { containerProfile: raw.containerProfile } : {}) };
  });
  if (new Set(workers.map((worker) => worker.id)).size !== workers.length) throw new RemoteWorkerError("Remote worker IDs must be unique"); return workers;
}

export class RemoteWorkers {
  private targets: WorkerTarget[] = [];
  private readonly directory: string;
  private readonly artifacts = new Set<string>();
  /** sshBinary is a transport fixture seam; application configuration cannot override it. */
  constructor(private readonly options: { home?: string; sshBinary?: string; environment?: NodeJS.ProcessEnv } = {}) { this.directory = join(resolve(options.home ?? process.env.CODEFLOW_HOME ?? join(homedir(), ".codeflow")), "remote-worker-private"); }
  async load() {
    registerPrivateEnvNames(["CODEFLOW_REMOTE_WORKERS_JSON", "CODEFLOW_REMOTE_WORKERS_FILE", "CODEFLOW_WORKER_CONFIG_FILE"]);
    const env = this.options.environment ?? process.env; let text = env.CODEFLOW_REMOTE_WORKERS_JSON;
    if (text && env.CODEFLOW_REMOTE_WORKERS_FILE) throw new RemoteWorkerError("Choose one remote worker configuration source");
    if (env.CODEFLOW_REMOTE_WORKERS_FILE) { const path = env.CODEFLOW_REMOTE_WORKERS_FILE; if (!isAbsolute(path)) throw new RemoteWorkerError("Remote worker configuration file must be absolute"); const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) throw new RemoteWorkerError("Remote worker configuration must be a bounded regular file"); text = await readFile(path, "utf8"); }
    if (text && Buffer.byteLength(text) > 128 * 1024) throw new RemoteWorkerError("Remote worker configuration exceeds 128 KiB");
    this.targets = text ? targetConfig(JSON.parse(text)) : [];
    await durableWorkerDirectory(this.directory); if (!(await lstat(this.directory)).isDirectory()) throw new RemoteWorkerError("Remote receipt store must be a regular directory");
    for (const name of await readdir(this.directory)) if (/^artifact-[A-Za-z0-9_-]+$/.test(name)) await rm(join(this.directory, name), { recursive: true, force: true });
  }
  list() { return this.targets.map(({ id, name, repoMappings, containerProfile }) => ({ id, name, repoMappings: [...repoMappings], containerProfile, protocol: 1 as const })); }
  private target(id: string, mapping?: string) { const target = this.targets.find((item) => item.id === id); if (!target || mapping && !target.repoMappings.includes(mapping)) throw new RemoteWorkerError("Select an explicitly registered worker and repository mapping"); return target; }
  private file(id: string) { if (!REQUEST_ID.test(id)) throw new RemoteWorkerError("Invalid remote request ID"); return join(this.directory, `${id}.json`); }
  private async remembered(workerId: string, id: string): Promise<PrivateRequest | undefined> {
    const file = this.file(id), info = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; }); if (!info) return undefined;
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new RemoteWorkerError("Private remote receipt is damaged"); const value = JSON.parse(await readFile(file, "utf8")) as PrivateRequest;
    if (value.version !== 1 || value.workerId !== workerId || value.requestId !== id || !CAPABILITY.test(value.capability) || !COMMIT_ID.test(value.baseCommit)) throw new RemoteWorkerError("Private remote receipt does not belong to this worker");
    if (value.targetFingerprint !== targetFingerprint(this.target(workerId))) throw new RemoteWorkerError("The registered SSH target changed. Restore its original host, command and profile before inspecting this private receipt."); return value;
  }
  private async remember(value: PrivateRequest) {
    if ((await readdir(this.directory)).filter((file) => file.endsWith(".json")).length >= 2000) throw new RemoteWorkerError("Inspect and archive remote receipts before creating more than 2,000 requests");
    const handle = await open(this.file(value.requestId), "wx", 0o600); try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    const folder = await open(this.directory, "r"); try { await folder.sync(); } finally { await folder.close(); }
  }
  private async exchange(target: WorkerTarget, frames: ClientFrame[], options: { timeoutMs?: number; signal?: AbortSignal; onEvent?: (event: AgentEvent) => void; onReceipt?: (receipt: WorkerReceipt) => void } = {}): Promise<Exchange> {
    return new Promise<Exchange>((resolveResult, reject) => {
      const child = spawn(this.options.sshBinary ?? "ssh", [...SSH_OPTIONS, target.sshHost, target.command], { env: sshEnvironment(), detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
      const result: Exchange = {}; let buffer = "", stderr = "", done = false, closed = false, hello = false, accepted = false, lastSeen = Date.now(), received = 0, events = 0, artifactOffset = 0; let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (signal: NodeJS.Signals) => { if (closed) return; try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { child.kill(signal); } };
      const finish = (error?: Error) => { if (done) return; done = true; clearTimeout(deadline); clearInterval(watch); options.signal?.removeEventListener("abort", abort); child.stdin.destroy(); stop("SIGTERM"); if (!closed) { killTimer = setTimeout(() => stop("SIGKILL"), 2000); killTimer.unref(); } if (error) reject(error); else resolveResult(result); };
      const abort = () => finish(new RemoteWorkerError("Remote transport was cancelled. Inspect the durable receipt before retrying.", accepted));
      const deadline = setTimeout(() => finish(new RemoteWorkerError("Remote channel exceeded its deadline; inspect its receipt before retrying", accepted)), options.timeoutMs ?? 20_000);
      const watch = setInterval(() => { if (accepted && Date.now() - lastSeen > 15_000) finish(new RemoteWorkerError("Remote heartbeat expired; execution outcome is ambiguous", true)); }, 1000);
      options.signal?.addEventListener("abort", abort, { once: true });
      const send = async () => { for (const frame of frames) { if (done) return; const line = JSON.stringify(frame) + "\n"; if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new RemoteWorkerError("Remote input exceeds its frame bound"); if (!child.stdin.write(line)) await once(child.stdin, "drain"); } };
      const handle = (frame: WorkerFrame) => {
        if (!frame || frame.v !== 1) throw new RemoteWorkerError("Unsupported worker protocol"); lastSeen = Date.now();
        if (frame.type === "hello") { if (hello || frame.protocol !== 1) throw new RemoteWorkerError("Unsupported worker handshake"); hello = true; void send().catch((error) => finish(error)); return; }
        if (!hello) throw new RemoteWorkerError("Worker did not identify its protocol");
        if (frame.type === "error") throw new RemoteWorkerError(typeof frame.message === "string" ? frame.message.slice(0, 2000) : "Worker rejected the request", accepted);
        if (frame.type === "probe") { const capabilities = validateWorkerCapabilities(frame.capabilities); if (frame.hasBase !== undefined && typeof frame.hasBase !== "boolean" || frame.hasRepositoryBase !== undefined && typeof frame.hasRepositoryBase !== "boolean") throw new RemoteWorkerError("Invalid worker commit availability"); result.probe = { capabilities, hasBase: frame.hasBase, hasRepositoryBase: frame.hasRepositoryBase }; finish(); return; }
        if (frame.type === "accepted" || frame.type === "heartbeat" || frame.type === "receipt" || frame.type === "result") {
          const receipt = frame.receipt; if (!receipt || receipt.version !== 1 || !REQUEST_ID.test(receipt.requestId) || !["accepted", "running", "completed", "failed", "cancelled", "unknown"].includes(receipt.state)) throw new RemoteWorkerError("Invalid worker receipt");
          const expected = frames.find((item) => item.type === "begin" || item.type === "receipt" || item.type === "cancel"); const id = expected?.type === "begin" ? expected.request.id : expected && "id" in expected ? expected.id : undefined;
          if (receipt.requestId !== id) throw new RemoteWorkerError("Worker receipt belongs to a different request"); result.receipt = receipt; accepted = true; options.onReceipt?.(receipt);
          if (frame.type === "result") { if (typeof frame.result?.ok !== "boolean" || typeof frame.result.finalText !== "string" || frame.result.finalText.length > 512 * 1024) throw new RemoteWorkerError("Invalid worker result"); result.result = { ...frame.result, sessionId: undefined }; if (result.artifact && artifactOffset !== result.artifact.size) throw new RemoteWorkerError("Remote artifact transfer is incomplete"); finish(); }
          else if (frame.type === "receipt" && (!receipt.artifact || frames.some((item) => item.type === "receipt" && item.downloadArtifact === false))) finish(); return;
        }
        if (frame.type === "event") { const size = Buffer.byteLength(JSON.stringify(frame.event)); events += size; if (size > 256 * 1024 || events > MAX_EVENTS_BYTES) throw new RemoteWorkerError("Worker events exceeded their bound", accepted); if (frame.event?.kind !== "session") options.onEvent?.(redactExport(frame.event)); return; }
        if (frame.type === "artifact") { const value = frame.artifact; if (result.artifact || !value || value.requestId !== result.receipt?.requestId || !COMMIT_ID.test(value.baseCommit) || !COMMIT_ID.test(value.head) || !DIGEST.test(value.sha256) || value.ref !== `refs/codeflow/results/${value.requestId}` || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_BUNDLE_BYTES) throw new RemoteWorkerError("Invalid remote artifact manifest"); result.artifact = value; result.bytes = Buffer.alloc(value.size); return; }
        if (frame.type === "chunk") { if (!result.bytes || frame.offset !== artifactOffset || typeof frame.data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) throw new RemoteWorkerError("Invalid remote artifact chunk"); const bytes = Buffer.from(frame.data, "base64"); if (!bytes.length || artifactOffset + bytes.length > result.bytes.length) throw new RemoteWorkerError("Remote artifact exceeded its manifest"); result.bytes.set(bytes, artifactOffset); artifactOffset += bytes.length; if (artifactOffset === result.bytes.length && frames.some((item) => item.type === "receipt")) finish(); return; }
        throw new RemoteWorkerError("Unknown worker response frame");
      };
      child.stdout.setEncoding("utf8"); child.stdout.on("data", (data: string) => { if (done) return; received += Buffer.byteLength(data); if (received > 112 * 1024 * 1024) { finish(new RemoteWorkerError("Remote response exceeded its total bound", accepted)); return; } buffer += data; try { let at: number; while ((at = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new RemoteWorkerError("Remote frame exceeds its bound", accepted); handle(JSON.parse(line)); if (done) return; } if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) throw new RemoteWorkerError("Remote frame exceeds its bound", accepted); } catch (error) { finish(error as Error); } });
      child.stderr.setEncoding("utf8"); child.stderr.on("data", (data: string) => { stderr = (stderr + data).slice(-2000); }); child.on("error", (error) => finish(new RemoteWorkerError(error.message, accepted))); child.on("close", () => { closed = true; clearTimeout(killTimer); if (!done) finish(new RemoteWorkerError(`SSH channel closed before a complete result${stderr ? `: ${redactExport(stderr).trim()}` : ""}`, accepted || frames.some((item) => item.type === "execute"))); }); child.stdin.on("error", () => undefined);
      if (options.signal?.aborted) abort();
    });
  }
  async probe(workerId: string, input: { repoMapping?: string; baseCommit?: string; repositoryBase?: string } = {}): Promise<Probe> { const target = this.target(workerId, input.repoMapping); for (const commit of [input.baseCommit, input.repositoryBase]) if (commit !== undefined && !COMMIT_ID.test(commit)) throw new RemoteWorkerError("Worker probe requires exact commit IDs"); const value = await this.exchange(target, [{ v: 1, type: "probe", ...input, containerProfile: target.containerProfile }]); return value.probe!; }
  private async outcome(record: PrivateRequest, value: Exchange): Promise<RemoteRunResult> {
    const receipt = value.receipt, state = receipt?.state ?? "unknown", ambiguous = !terminal(state);
    const result: RemoteRunResult = { ...(value.result ?? receipt?.result ?? { ok: false, finalText: "", error: receipt?.reason ?? "Remote outcome is ambiguous; inspect its receipt before explicitly retrying", errorKind: "other" }), sessionId: undefined, remote: { workerId: record.workerId, requestId: record.requestId, state, receipt: receipt?.fingerprint, ...(ambiguous ? { ambiguous: true } : {}), baseCommit: record.baseCommit, resultHead: value.artifact?.head ?? receipt?.artifact?.head } };
    if (value.artifact && value.bytes) { if (value.artifact.baseCommit !== record.baseCommit || sha256(value.bytes) !== value.artifact.sha256) throw new RemoteWorkerError("Remote artifact failed its digest or accepted base"); if (this.artifacts.size >= 32) throw new RemoteWorkerError("Import or discard pending remote artifacts before downloading more than 32 bundles"); const folder = await mkdtemp(join(this.directory, "artifact-")); const file = join(folder, "result.bundle"); await writeFile(file, value.bytes, { flag: "wx", mode: 0o600 }); this.artifacts.add(file); result.artifact = { ...value.artifact, file }; }
    return result;
  }
  async hasRequest(workerId: string, id: string) { return !!await this.remembered(workerId, id); }
  private assertScope(record: PrivateRequest, expected?: { runId: string; stepIds: readonly string[] }) { if (expected && (record.scope.runId !== expected.runId || !expected.stepIds.includes(record.scope.stepId))) throw new RemoteWorkerError("The private remote capability belongs to a different run or step"); }
  async receipt(workerId: string, id: string, options: { downloadArtifact?: boolean; expectedScope?: { runId: string; stepIds: readonly string[] } } = {}): Promise<RemoteRunResult> { const record = await this.remembered(workerId, id); if (!record) throw new RemoteWorkerError("This server has no private capability for that remote request"); this.assertScope(record, options.expectedScope); return this.outcome(record, await this.exchange(this.target(workerId), [{ v: 1, type: "receipt", id, capability: record.capability, downloadArtifact: options.downloadArtifact }], { timeoutMs: 90_000 })); }
  async cancel(workerId: string, id: string, options: { expectedScope?: { runId: string; stepIds: readonly string[] } } = {}) { const record = await this.remembered(workerId, id); if (!record) throw new RemoteWorkerError("This server has no private capability for that remote request"); this.assertScope(record, options.expectedScope); return this.outcome(record, await this.exchange(this.target(workerId), [{ v: 1, type: "cancel", id, capability: record.capability }])); }
  async execute(input: { workerId: string; repoMapping: string; requestId?: string; scope: WorkerRequest["scope"]; repositoryBase?: string; options: RunOptions & { agent?: WorkerRequest["agent"] }; agent?: WorkerRequest["agent"]; onReceipt?: (remote: RemoteRunResult["remote"]) => void }, onEvent: (event: AgentEvent) => void): Promise<RemoteRunResult> {
    const target = this.target(input.workerId, input.repoMapping), opts = input.options, agent = input.agent ?? opts.agent;
    if (!agent) throw new RemoteWorkerError("Remote execution requires an explicit provider");
    if (opts.interactiveApprovals || opts.teamTools || opts.resumeSessionId) throw new RemoteWorkerError("Remote turns use fresh sessions and structured replies; native approvals, live team tools and resumed sessions are unsupported");
    if (opts.agentContainer && !target.containerProfile) throw new RemoteWorkerError("Register an explicit worker-local container profile; host container settings and credential volumes are never forwarded");
    const id = input.requestId ?? randomBytes(16).toString("hex"), baseCommit = await resolveCommit(opts.cwd);
    await assertTransferTree(opts.cwd, baseCommit); const integrity = await verificationIntegrity(opts.cwd, opts.signal); if (integrity.head !== baseCommit) throw new RemoteWorkerError("The source checkout changed before transfer");
    const fingerprint = sha256(JSON.stringify({ scope: input.scope, repoMapping: input.repoMapping, agent, baseCommit, mode: opts.mode, prompt: opts.prompt, model: opts.model, effort: opts.effort, trust: opts.trust ?? "standard", jsonSchema: opts.jsonSchema }));
    const prior = await this.remembered(input.workerId, id); if (prior) { if (prior.fingerprint !== fingerprint) throw new RemoteWorkerError("Remote request ID already belongs to another scoped invocation"); return this.receipt(input.workerId, id); }
    const probe = await this.probe(input.workerId, { repoMapping: input.repoMapping, baseCommit, repositoryBase: input.repositoryBase });
    if (!probe.capabilities.repoMappings.includes(input.repoMapping) || !probe.capabilities.providers.some((item) => item.id === agent && item.available) || target.containerProfile && !probe.capabilities.containerProfiles.includes(target.containerProfile)) throw new RemoteWorkerError("Selected provider, mapping or worker-local container profile is unavailable on the registered worker");
    const context = await contextManifest(opts.cwd), capability = randomBytes(32).toString("hex"), transfer = probe.hasBase ? undefined : await sourceBundle(opts.cwd, baseCommit, id, probe.hasRepositoryBase ? input.repositoryBase : undefined);
    const request = validateWorkerRequest({ id, capability, scope: input.scope, repoMapping: input.repoMapping, baseCommit, agent, mode: opts.mode, prompt: opts.prompt, model: opts.model, effort: opts.effort, trust: opts.trust ?? "standard", timeoutMs: Math.min(opts.timeoutMs ?? 30 * 60_000, 30 * 60_000), idleTimeoutMs: opts.idleTimeoutMs, jsonSchema: opts.jsonSchema, questionProtocol: opts.questionProtocol, containerProfile: target.containerProfile, context: context.files, ...(transfer ? { source: { size: transfer.size, sha256: transfer.sha256, ref: transfer.ref } } : {}) });
    const record: PrivateRequest = { version: 1, workerId: input.workerId, requestId: id, capability, scope: input.scope, baseCommit, fingerprint, targetFingerprint: targetFingerprint(target), createdAt: Date.now() };
    await integrity.assert("source transfer"); await this.remember(record);
    const frames: ClientFrame[] = [{ v: 1, type: "begin", request }]; if (transfer) for (const chunk of chunks(transfer.data)) frames.push({ v: 1, type: "source", id, capability, ...chunk }); for (const [path, bytes] of context.data) for (const chunk of chunks(bytes)) frames.push({ v: 1, type: "context", id, capability, path, ...chunk }); frames.push({ v: 1, type: "execute", id, capability });
    const abort = () => { void this.cancel(input.workerId, id).catch(() => undefined); }; opts.signal?.addEventListener("abort", abort, { once: true });
    try { return await this.outcome(record, await this.exchange(target, frames, { onEvent, signal: opts.signal, timeoutMs: request.timeoutMs + 45_000, onReceipt: (receipt) => input.onReceipt?.({ workerId: input.workerId, requestId: id, baseCommit, state: receipt.state, receipt: receipt.fingerprint, ...(receipt.state === "unknown" ? { ambiguous: true } : {}) }) })); }
    catch (error) { return { ok: false, finalText: "", error: redactExport((error as Error).message), errorKind: opts.signal?.aborted ? "cancelled" : "other", remote: { workerId: input.workerId, requestId: id, baseCommit, state: "unknown", ambiguous: true } }; }
    finally { opts.signal?.removeEventListener("abort", abort); }
  }
  async importArtifact(repo: string, artifact: WorkerArtifact & { file: string }, expectedHead: string) { if (!this.artifacts.has(artifact.file)) throw new RemoteWorkerError("Artifact does not belong to this worker client"); try { return await importWorkerArtifact(repo, artifact, expectedHead); } finally { this.artifacts.delete(artifact.file); await rm(resolve(artifact.file, ".."), { recursive: true, force: true }); } }
  async discardArtifact(artifact: WorkerArtifact & { file: string }) { if (this.artifacts.delete(artifact.file)) await rm(resolve(artifact.file, ".."), { recursive: true, force: true }); }
}
