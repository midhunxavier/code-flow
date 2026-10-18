import type { AgentEvent, AgentId, RunOptions, RunResult } from "../adapters/types.js";

export const WORKER_PROTOCOL = 1;
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
export const MAX_CONTEXT_BYTES = 16 * 1024 * 1024;
export const CHUNK_BYTES = 192 * 1024;
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const MAX_EVENTS_BYTES = 16 * 1024 * 1024;
export const REQUEST_ID = /^[a-f0-9]{32}$/;
export const CAPABILITY = /^[a-f0-9]{64}$/;
export const COMMIT_ID = /^[a-f0-9]{40,64}$/i;
export const DIGEST = /^[a-f0-9]{64}$/;
export interface WorkerTarget { id: string; name: string; sshHost: string; command: string; repoMappings: string[]; containerProfile?: string }
export interface WorkerSelection { workerId: string; repoMapping: string }
export function validateWorkerSelection(value: unknown): WorkerSelection | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["workerId", "repoMapping"].includes(key)) || !/^[a-z][a-z0-9-]{0,63}$/.test((value as WorkerSelection).workerId) || !/^[a-z][a-z0-9-]{0,63}$/.test((value as WorkerSelection).repoMapping)) throw new RemoteWorkerError("Choose a registered worker ID and repository mapping");
  return { workerId: (value as WorkerSelection).workerId, repoMapping: (value as WorkerSelection).repoMapping };
}
export interface ContextFile { path: string; size: number; sha256: string }
export interface WorkerRequest {
  id: string; capability: string;
  scope: { runId: string; stepId: string; threadId: string };
  repoMapping: string; baseCommit: string; agent: AgentId; mode: "read" | "write";
  prompt: string; model?: string; effort?: string; trust: NonNullable<RunOptions["trust"]>;
  timeoutMs: number; idleTimeoutMs?: number; jsonSchema?: object; questionProtocol?: "structured";
  containerProfile?: string;
  source?: { size: number; sha256: string; ref: string };
  context: ContextFile[];
}
export interface WorkerArtifact { requestId: string; baseCommit: string; head: string; size: number; sha256: string; ref: string }
export type ReceiptState = "accepted" | "running" | "completed" | "failed" | "cancelled" | "unknown";
export interface WorkerReceipt { version: 1; requestId: string; state: ReceiptState; fingerprint?: string; createdAt?: number; updatedAt?: number; heartbeatAt?: number; result?: RunResult; artifact?: WorkerArtifact; reason?: string }
export interface WorkerCapabilities { protocol: 1; providers: { id: AgentId; available: boolean }[]; repoMappings: string[]; containerProfiles: string[]; resumeSessions: false; liveTeamTools: false; interactiveApprovals: false; stagedContext: true; maximumBundleBytes: number; maximumContextBytes: number }
export type ClientFrame =
  | { v: 1; type: "probe"; repoMapping?: string; baseCommit?: string; repositoryBase?: string; containerProfile?: string }
  | { v: 1; type: "begin"; request: WorkerRequest }
  | { v: 1; type: "source" | "context"; id: string; capability: string; path?: string; offset: number; data: string }
  | { v: 1; type: "execute" | "receipt" | "cancel"; id: string; capability: string; downloadArtifact?: boolean };
export type WorkerFrame =
  | { v: 1; type: "hello"; protocol: 1 }
  | { v: 1; type: "probe"; capabilities: WorkerCapabilities; hasBase?: boolean; hasRepositoryBase?: boolean }
  | { v: 1; type: "accepted" | "heartbeat" | "receipt"; receipt: WorkerReceipt }
  | { v: 1; type: "event"; event: AgentEvent }
  | { v: 1; type: "artifact"; artifact: WorkerArtifact }
  | { v: 1; type: "chunk"; offset: number; data: string }
  | { v: 1; type: "result"; receipt: WorkerReceipt; result: RunResult }
  | { v: 1; type: "error"; message: string };
export class RemoteWorkerError extends Error { constructor(message: string, readonly ambiguous = false) { super(message); } }
export function validateWorkerCapabilities(value: unknown): WorkerCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RemoteWorkerError("Invalid worker capabilities");
  const raw = value as WorkerCapabilities, mapping = (item: unknown) => typeof item === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(item);
  if (raw.protocol !== 1 || !Array.isArray(raw.providers) || raw.providers.length > 3 || raw.providers.some((provider) => !provider || typeof provider !== "object" || Object.keys(provider).some((key) => !["id", "available"].includes(key)) || !["claude", "codex", "agy"].includes(provider.id) || typeof provider.available !== "boolean") || new Set(raw.providers.map((provider) => provider.id)).size !== raw.providers.length || !Array.isArray(raw.repoMappings) || raw.repoMappings.length > 20 || !raw.repoMappings.every(mapping) || !Array.isArray(raw.containerProfiles) || raw.containerProfiles.length > 20 || !raw.containerProfiles.every(mapping) || raw.resumeSessions !== false || raw.liveTeamTools !== false || raw.interactiveApprovals !== false || raw.stagedContext !== true || raw.maximumBundleBytes !== MAX_BUNDLE_BYTES || raw.maximumContextBytes !== MAX_CONTEXT_BYTES) throw new RemoteWorkerError("Invalid or incompatible bounded worker capabilities");
  return structuredClone(raw);
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const bounded = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
export function contextPath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(".codeflow-context/") && value.length <= 500 && !/[\\\x00-\x1f\x7f]/.test(value) && !value.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") && !/(^|\/)(?:\.env(?:\..*)?|.*\.(?:pem|key))$/i.test(value);
}
export function validateWorkerRequest(value: unknown): WorkerRequest {
  if (!object(value) || !REQUEST_ID.test(String(value.id)) || !CAPABILITY.test(String(value.capability)) || !object(value.scope) || Object.values(value.scope).length !== 3 || ![value.scope.runId, value.scope.stepId, value.scope.threadId].every((item) => bounded(item, 256)) || !bounded(value.repoMapping, 64) || !/^[a-z][a-z0-9-]*$/.test(value.repoMapping as string) || !COMMIT_ID.test(String(value.baseCommit)) || !["claude", "codex", "agy"].includes(String(value.agent)) || !["read", "write"].includes(String(value.mode)) || !["safe", "standard", "trusted", "full"].includes(String(value.trust)) || !bounded(value.prompt, 512 * 1024) || !Number.isInteger(value.timeoutMs) || (value.timeoutMs as number) < 100 || (value.timeoutMs as number) > 30 * 60_000) throw new RemoteWorkerError("Invalid or unbounded remote execution request");
  if (value.model !== undefined && !/^[A-Za-z0-9][\w.:/[\]@-]{0,99}$/.test(String(value.model)) || value.effort !== undefined && !/^[a-z]{2,12}$/.test(String(value.effort)) || value.idleTimeoutMs !== undefined && (!Number.isInteger(value.idleTimeoutMs) || (value.idleTimeoutMs as number) < 100 || (value.idleTimeoutMs as number) > 30 * 60_000)) throw new RemoteWorkerError("Invalid remote model, effort or idle timeout");
  if (value.jsonSchema !== undefined && (!object(value.jsonSchema) || JSON.stringify(value.jsonSchema).length > 128 * 1024)) throw new RemoteWorkerError("Remote output schema exceeds its bound");
  if (value.containerProfile !== undefined && !/^[a-z][a-z0-9-]{0,63}$/.test(String(value.containerProfile)) || value.questionProtocol !== undefined && value.questionProtocol !== "structured") throw new RemoteWorkerError("Invalid worker-local execution profile");
  if (!Array.isArray(value.context) || value.context.length > 100 || value.context.some((file) => !object(file) || !contextPath(file.path) || typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 8 * 1024 * 1024 || typeof file.sha256 !== "string" || !DIGEST.test(file.sha256)) || (value.context as ContextFile[]).reduce((total, file) => total + file.size, 0) > MAX_CONTEXT_BYTES || new Set((value.context as ContextFile[]).map((file) => file.path)).size !== value.context.length) throw new RemoteWorkerError("Remote context must contain at most 100 bounded regular reference files");
  if (value.source !== undefined && (!object(value.source) || !Number.isSafeInteger(value.source.size) || (value.source.size as number) < 1 || (value.source.size as number) > MAX_BUNDLE_BYTES || !DIGEST.test(String(value.source.sha256)) || value.source.ref !== `refs/codeflow/transfers/${value.id}`)) throw new RemoteWorkerError("Invalid source bundle manifest");
  const allowed = ["id", "capability", "scope", "repoMapping", "baseCommit", "agent", "mode", "prompt", "model", "effort", "trust", "timeoutMs", "idleTimeoutMs", "jsonSchema", "questionProtocol", "containerProfile", "source", "context"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new RemoteWorkerError("Remote requests cannot forward arbitrary environment, callbacks, session handles or paths");
  return structuredClone(value) as unknown as WorkerRequest;
}
