/** Browser-safe serving contracts. Every request resolves one immutable release. */
import { digest, id, integer, isLlm, LLM_RECIPE, MlError, modelSnapshot, object, recipe, string, type Experiment, type ModelSnapshot, type Recipe, type Target } from "./model.js";
export interface ServingConfig { mode?: "persistent"; memoryMiB?: number; idleSeconds?: number; lifetimeSeconds?: number; device: "cpu" | "mps" | "cuda"; gpu?: string; cpus: number; timeoutSeconds: number; maxRows: number; maxInputTokens: number; maxNewTokens: number }
export interface ServingRelease {
  id: string; controllerId: string; workerId: string; bundle: string; versionId: string; recipe: Recipe;
  artifact: { hash: string; bytes: number }; modelHash: string; trainingBundle: string;
  features: string[]; base?: ModelSnapshot; config: ServingConfig;
}
export interface Deployment {
  id: string; project: string; repo: string; name: string; modelId: string; target: Target; config: ServingConfig;
  createdAt: number; revision: number; enabled: boolean; cleanupPending?: boolean; current: string; releases: ServingRelease[];
  history: { operationId: string; requestHash: string; action: "deploy" | "switch" | "rollback" | "stop" | "resume"; from?: string; to: string; at: number; reason: string; reviewed: boolean; comparison: string[] }[];
}
export type InferenceInput = { rows: Record<string, string | number | boolean | null>[] } | { prompt?: string; messages?: { role: "system" | "user" | "assistant"; content: string }[]; maxNewTokens: number };
export function servingConfig(raw: unknown, llm: boolean): ServingConfig {
  const v = object(raw, ["device", "gpu", "cpus", "timeoutSeconds", "maxRows", "maxInputTokens", "maxNewTokens", "mode", "memoryMiB", "idleSeconds", "lifetimeSeconds"], "inference limits");
  if (!["cpu", "mps", "cuda"].includes(v.device) || !llm && v.device !== "cpu") throw new MlError("Choose a supported inference device");
  if (v.device === "cuda" ? typeof v.gpu !== "string" || !/^GPU-[a-fA-F0-9-]{8,80}$/.test(v.gpu) : v.gpu !== undefined) throw new MlError("Choose an explicit NVIDIA GPU for CUDA inference");
  if (v.mode !== undefined && v.mode !== "persistent" || v.mode === undefined && [v.memoryMiB, v.idleSeconds, v.lifetimeSeconds].some(x => x !== undefined)) throw new MlError("Choose persistent mode to set residency limits");
  const resident = v.mode === "persistent" ? { mode: "persistent" as const, memoryMiB: integer(v.memoryMiB, 256, 262144, "Serving memory MiB"), idleSeconds: integer(v.idleSeconds, 10, 3600, "Idle timeout"), lifetimeSeconds: integer(v.lifetimeSeconds, 30, 86400, "Serving lifetime") } : {};
  if (resident.idleSeconds! > resident.lifetimeSeconds!) throw new MlError("Idle timeout cannot exceed the serving lifetime");
  return { ...resident, device: v.device, ...(v.gpu ? { gpu: v.gpu } : {}), cpus: integer(v.cpus, 1, 32, "Inference CPU threads"), timeoutSeconds: integer(v.timeoutSeconds, 5, 90, "Inference timeout"), maxRows: integer(v.maxRows ?? 32, 1, 100, "Batch row limit"), maxInputTokens: integer(v.maxInputTokens ?? 512, 1, 4096, "Input token limit"), maxNewTokens: integer(v.maxNewTokens ?? 64, 1, 512, "Output token limit") };
}
export function release(raw: unknown): ServingRelease {
  const v = object(raw, ["id", "controllerId", "workerId", "bundle", "versionId", "recipe", "artifact", "modelHash", "trainingBundle", "features", "base", "config"], "serving release");
  for (const key of ["id", "controllerId", "workerId", "versionId"]) id(v[key]);
  digest(v.bundle); digest(v.trainingBundle); digest(v.modelHash); const selected = recipe(v.recipe);
  const a = object(v.artifact, ["hash", "bytes"], "serving artifact"); digest(a.hash); integer(a.bytes, 1, 512 * 1024 ** 2, "Serving artifact bytes");
  if (!Array.isArray(v.features) || v.features.length > 1000 || new Set(v.features).size !== v.features.length) throw new MlError("Invalid inference columns");
  v.features.forEach((c: unknown) => string(c, "feature column", 200));
  if (selected === LLM_RECIPE) modelSnapshot(v.base); else if (v.base || !v.features.length) throw new MlError("Invalid tabular release");
  const config = servingConfig(v.config, selected === LLM_RECIPE);
  if (v.base && config.maxInputTokens + config.maxNewTokens > v.base.contextLength) throw new MlError("Input and output token limits exceed the base model context");
  return v as ServingRelease;
}
export function releaseInputs(e: Experiment) {
  const spec = e.intent.spec!;
  return { recipe: recipe(e.intent.recipe), artifact: { hash: e.status.artifact!.hash, bytes: e.status.artifact!.bytes }, modelHash: e.status.evaluation!.modelHash, trainingBundle: e.intent.bundle, features: isLlm(spec) ? [] : e.intent.dataset!.columns.filter(c => c !== spec.label && c !== (spec.split.kind === "random" ? undefined : spec.split.column)).sort(), ...(e.intent.model ? { base: e.intent.model } : {}) };
}
export function inferenceInput(raw: unknown, r: ServingRelease): InferenceInput {
  if (new TextEncoder().encode(JSON.stringify(raw)).length > 64000) throw new MlError("Inference input exceeds 64 KB", 413);
  if (r.recipe !== LLM_RECIPE) {
    const v = object(raw, ["rows"], "prediction input");
    if (!Array.isArray(v.rows) || !v.rows.length || v.rows.length > r.config.maxRows) throw new MlError(`Supply 1–${r.config.maxRows} rows`);
    for (const row of v.rows) { object(row, r.features, "prediction row"); if (Object.keys(row).length !== r.features.length || r.features.some(c => !Object.hasOwn(row, c))) throw new MlError("Each row must contain exactly the model's feature columns"); for (const value of Object.values(row)) if (!(value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) || typeof value === "string" && value.length <= 4096)) throw new MlError("Prediction cells must be finite numbers, text, booleans or null"); }
    return v as InferenceInput;
  }
  const v = object(raw, ["prompt", "messages", "maxNewTokens"], "generation input");
  if ((v.prompt === undefined) === (v.messages === undefined)) throw new MlError("Supply a prompt or chat messages");
  if (v.prompt !== undefined && (typeof v.prompt !== "string" || !v.prompt.trim() || v.prompt.length > 32000 || v.prompt.includes("\0"))) throw new MlError("Supply a prompt of up to 32,000 characters");
  if (v.messages !== undefined) {
    if (!Array.isArray(v.messages) || !v.messages.length || v.messages.length > 32 || v.messages.at(-1)?.role !== "user") throw new MlError("Supply up to 32 messages ending with a user message");
    for (const m of v.messages) { object(m, ["role", "content"], "chat message"); if (!["system", "user", "assistant"].includes(m.role) || typeof m.content !== "string" || !m.content.trim() || m.content.length > 32000 || m.content.includes("\0")) throw new MlError("Invalid chat message"); }
  }
  return { ...v, maxNewTokens: integer(v.maxNewTokens ?? r.config.maxNewTokens, 1, r.config.maxNewTokens, "Output tokens") } as InferenceInput;
}
export function inferenceResult(raw: unknown, r: ServingRelease, input?: InferenceInput) {
  if (JSON.stringify(raw)?.length > 256000) throw new MlError("Inference response exceeds its limit", 502);
  if (!input) { const v = object(raw, ["ready"], "load result"); if (v.ready !== true) throw new MlError("Model did not become ready", 502); return v; }
  if (r.recipe !== LLM_RECIPE) {
    const v = object(raw, ["predictions"], "prediction result");
    if (!Array.isArray(v.predictions) || v.predictions.length !== (input as { rows: unknown[] }).rows.length || v.predictions.some((p: unknown) => !(typeof p === "string" || typeof p === "boolean" || typeof p === "number" && Number.isFinite(p) || p === null))) throw new MlError("Invalid predictions", 502);
    return v;
  }
  const v = object(raw, ["text", "inputTokens", "outputTokens"], "generation result");
  if (typeof v.text !== "string") throw new MlError("Invalid generated text", 502);
  integer(v.inputTokens, 1, r.config.maxInputTokens, "Input tokens"); integer(v.outputTokens, 0, (input as { maxNewTokens: number }).maxNewTokens, "Output tokens"); return v;
}

export interface ResidentStatus { state: "unloaded" | "loading" | "ready" | "busy" | "stopped" | "unknown"; sessionId?: string; revision?: number; deploymentId?: string; releaseId?: string; pid?: number; startedAt?: number; expiresAt?: number; memoryBytes?: number; reason?: string }
export type InferenceEvent = { type: "meta"; deploymentId: string; revision: number; versionId: string; releaseId: string; sessionId: string } | { type: "delta"; text: string } | { type: "heartbeat" };
