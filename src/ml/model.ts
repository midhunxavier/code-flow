import { holdoutInput, holdoutResult, type HoldoutInput, type HoldoutResult } from "./holdout-model.js";
/** Shared wire types; this module has no Node dependencies and may be imported by the UI. */
export const ML_PROTOCOL = 1;
export const DATA_LIMIT = 128 * 1024 * 1024;
export const CHUNK_BYTES = 256 * 1024;
export const RECIPE = "tabular-autogluon-v1";
export const LLM_RECIPE = "llm-sft-lora-v1";
export type Recipe = typeof RECIPE | typeof LLM_RECIPE;
export function recipe(value: unknown = RECIPE): Recipe { if (value !== RECIPE && value !== LLM_RECIPE) throw new MlError("Unsupported training recipe"); return value; }
export interface LlmSpec {
  task: "sft"; device: "cpu" | "mps" | "cuda"; gpu?: string;
  maxLength: number; maxSteps: number; rank: number; learningRate: number;
  accumulation: number; seed: number; cpus: number; trainSeconds: number;
}
export interface ModelSnapshot { hash: string; bytes: number; parameters: number; architecture: string; contextLength: number; files: number }
export type JobSpec = TrainingSpec | LlmSpec;
export const isLlm = (spec?: JobSpec): spec is LlmSpec => spec?.task === "sft";
export type Task = "classification" | "regression";
export type Split = { kind: "random" } | { kind: "group" | "time"; column: string };
export interface TrainingSpec {
  task: Task; label: string; split: Split; seed: number; trainSeconds: number; cpus: number; forest?: { trees: number; depth: number };
}
export interface Dataset {
  id: string; hash: string; bytes: number; format: "csv" | "parquet" | "jsonl"; schema?: "prompt-completion" | "messages";
  rows: number; columns: string[]; missing: Record<string, number>; duplicateRows: number;
}
export interface ProcessIdentity { pid: number; started: string; boot: string }
export interface Intent {
  version: 1; id: string; workerId: string; controllerId: string; bundle: string;
  kind: "training" | "setup" | "model" | "holdout"; holdout?: HoldoutInput; recipe?: Recipe; model?: ModelSnapshot; modelPath?: string; createdAt: number; deadline: number;
  dataset?: Dataset; spec?: JobSpec; source?: { commit: string; project: string };
  python?: string; search?: { cycleId: string; partition: "validation" | "test"; fromJob?: { id: string; modelHash: string } };
}
export type JobState = "submitted" | "preparing" | "training" | "evaluating" | "exporting" | "succeeded" | "failed" | "cancel_requested" | "cancelled" | "unknown";
export const terminal = (state: JobState) => ["succeeded", "failed", "cancelled"].includes(state);
export interface Evaluation {
  partition?: "validation" | "test"; metric: "accuracy" | "rmse" | "completion_nll"; evaluatedTokens?: number; baseModelHash?: string; direction: "higher" | "lower"; baseline: number; candidate: number;
  improved: boolean; trainRows: number; tuningRows: number; testRows: number; droppedDuplicates: number;
  datasetHash: string; splitHash: string; modelHash: string; recipe: string; seed: number;
}
export interface JobStatus {
  id: string; state: JobState; updatedAt: number; startedAt?: number; endedAt?: number;
  runner?: ProcessIdentity; child?: ProcessIdentity; error?: string; evaluation?: Evaluation; holdout?: HoldoutResult;
  model?: ModelSnapshot; progress?: { step: number; totalSteps: number; loss?: number };
  artifact?: { hash: string; bytes: number; filename: string };
}
export interface Probe {
  workerId: string; protocol: number; commonHoldout?: 1; boundedSearch?: 1; dataWatch?: 1; serving?: 1; persistentServing?: 1; platform: string; hostname: string; cpus: number;
  memoryBytes: number; freeBytes: number; python: string; ready: boolean; issue?: string;
  recipe: string; recipes?: { id: Recipe; ready: boolean; python: string; issue?: string; devices?: string[] }[]; gpus: { uuid: string; name: string; memoryMiB: number; freeMiB?: number }[];
  limits: { datasetBytes: number; concurrentJobs: number; hardMemoryLimit: boolean };
}
export interface Target {
  id: string; revision: number; name: string; kind: "local" | "ssh"; host?: string;
  directory: string; python: string; workerId?: string; bundle?: string;
}
export interface Experiment {
  id: string; project: string; repo: string; name: string; operationId: string; requestHash: string;
  registry?: { modelId: string; versionId: string };
  target: Target; intent: Intent; status: JobStatus; cancelRequestedAt?: number;
}
export class MlError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export class InferenceInputError extends MlError { constructor(message: string) { super(message, 400); this.name = "InferenceInputError"; } }
export class MlBusyError extends MlError { constructor(message: string) { super(message, 409); } }
export function object(value: unknown, keys: readonly string[], label = "request"): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new MlError(`Invalid ${label} fields`);
  return value as Record<string, any>;
}
export function string(value: unknown, label: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new MlError(`Enter a valid ${label}`);
  return value;
}
export function id(value: unknown): string {
  const result = string(value, "identifier", 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(result)) throw new MlError("Invalid identifier");
  return result;
}
export function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new MlError("Invalid content hash");
  return value;
}
export function integer(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new MlError(`${label} must be between ${min} and ${max}`);
  return Number(value);
}
export function jobStatus(raw: unknown): JobStatus {
  const v = object(raw, ["id", "state", "updatedAt", "startedAt", "endedAt", "runner", "child", "error", "evaluation", "holdout", "artifact", "model", "progress"], "job status");
  id(v.id);
  if (!["submitted", "preparing", "training", "evaluating", "exporting", "succeeded", "failed", "cancel_requested", "cancelled", "unknown"].includes(v.state)) throw new MlError("Invalid worker state", 502);
  integer(v.updatedAt, 1, Number.MAX_SAFE_INTEGER, "Status time");
  for (const key of ["startedAt", "endedAt"]) if (v[key] !== undefined) integer(v[key], 1, Number.MAX_SAFE_INTEGER, key);
  for (const key of ["runner", "child"]) if (v[key] !== undefined) {
    const p = object(v[key], ["pid", "started", "boot"], "process identity");
    integer(p.pid, 1, 2147483647, "Process ID"); string(p.started, "process start"); string(p.boot, "boot identity");
  }
  if (v.error !== undefined && (typeof v.error !== "string" || v.error.length > 16000)) throw new MlError("Invalid job error", 502);
  if (v.model !== undefined) modelSnapshot(v.model);
  if (v.progress !== undefined) { const p = object(v.progress, ["step", "totalSteps", "loss"], "progress"); integer(p.totalSteps, 1, 2000, "Total steps"); integer(p.step, 0, p.totalSteps, "Step"); if (p.loss !== undefined && !Number.isFinite(p.loss)) throw new MlError("Invalid progress loss"); }
  if (v.holdout !== undefined) holdoutResult(v.holdout);
  if (v.evaluation !== undefined) {
    const e = object(v.evaluation, ["partition", "metric", "direction", "baseline", "candidate", "improved", "trainRows", "tuningRows", "testRows", "droppedDuplicates", "datasetHash", "splitHash", "modelHash", "recipe", "seed", "evaluatedTokens", "baseModelHash"], "evaluation");
    if (e.partition !== undefined && !["validation", "test"].includes(e.partition)) throw new MlError("Invalid evaluation partition");
    if (!["accuracy", "rmse", "completion_nll"].includes(e.metric) || e.direction !== (e.metric === "accuracy" ? "higher" : "lower") || !Number.isFinite(e.baseline) || !Number.isFinite(e.candidate) || typeof e.improved !== "boolean" || !([RECIPE, LLM_RECIPE].includes(e.recipe))) throw new MlError("Invalid evaluation evidence", 502);
    if (e.baseline < 0 || e.candidate < 0 || e.metric === "accuracy" && (e.baseline > 1 || e.candidate > 1) || e.improved !== (e.direction === "higher" ? e.candidate > e.baseline : e.candidate < e.baseline)) throw new MlError("Invalid metric comparison", 502);
    if ((e.recipe === LLM_RECIPE) !== (e.metric === "completion_nll")) throw new MlError("Evaluation recipe mismatch");
    if (e.metric === "completion_nll") { if (e.recipe !== LLM_RECIPE) throw new MlError("Evaluation recipe mismatch"); integer(e.evaluatedTokens, 1, 100000000, "Evaluated tokens"); digest(e.baseModelHash); }
    for (const key of ["trainRows", "tuningRows", "testRows"]) integer(e[key], 5, 250000, key);
    integer(e.droppedDuplicates, 0, 250000, "Duplicate rows"); integer(e.seed, 0, 2147483647, "Seed");
    for (const key of ["datasetHash", "splitHash", "modelHash"]) digest(e[key]);
  }
  if (v.artifact !== undefined) { const a = object(v.artifact, ["hash", "bytes", "filename"], "artifact"); digest(a.hash); integer(a.bytes, 1, 512 * 1024 * 1024, "Artifact bytes"); if (a.filename !== "model.tar.gz") throw new MlError("Invalid model export", 502); }
  return v as JobStatus;
}
export function trainingSpec(raw: unknown): TrainingSpec {
  const v = object(raw, ["task", "label", "split", "seed", "trainSeconds", "cpus", "forest"]);
  if (!["classification", "regression"].includes(v.task)) throw new MlError("Choose classification or regression");
  const split = object(v.split, ["kind", "column"], "split");
  if (!["random", "time", "group"].includes(split.kind)) throw new MlError("Choose a random, group or time split");
  if (split.kind === "random" && split.column !== undefined) throw new MlError("Random splits do not use a split column");
  const label = string(v.label, "target column");
  const column = split.kind === "random" ? undefined : string(split.column, "split column");
  if (column === label) throw new MlError("The target cannot be the split column");
  const forest = v.forest === undefined ? undefined : object(v.forest, ["trees", "depth"], "forest settings");
  return { ...(forest ? { forest: { trees: integer(forest.trees, 16, 256, "Trees"), depth: integer(forest.depth, 2, 32, "Tree depth") } } : {}), task: v.task, label, split: column ? { kind: split.kind, column } : { kind: "random" }, seed: integer(v.seed ?? 42, 0, 2147483647, "Seed"), trainSeconds: integer(v.trainSeconds, 10, 3600, "Training seconds"), cpus: integer(v.cpus, 1, 32, "CPU threads") };
}
export function dataset(raw: unknown): Dataset {
  const d = object(raw, ["id", "hash", "bytes", "format", "rows", "columns", "missing", "duplicateRows", "schema"], "dataset");
  if (!["csv", "parquet", "jsonl"].includes(d.format) || !Array.isArray(d.columns) || d.columns.length < (d.format === "jsonl" ? 1 : 2) || d.columns.length > 256 || new Set(d.columns).size !== d.columns.length) throw new MlError("Invalid dataset schema");
  if (d.format === "jsonl" ? !["prompt-completion", "messages"].includes(d.schema) : d.schema !== undefined) throw new MlError("Invalid dataset format");
  const columns = d.columns.map((c: unknown) => string(c, "column"));
  const missing = object(d.missing, columns, "missing counts");
  const rows = integer(d.rows, 30, d.format === "jsonl" ? 10000 : 250000, "Dataset rows");
  for (const c of columns) integer(missing[c], 0, rows, "Missing rows");
  return { id: id(d.id), hash: digest(d.hash), bytes: integer(d.bytes, 1, d.format === "jsonl" ? 32 * 1024 * 1024 : DATA_LIMIT, "Dataset bytes"), format: d.format, rows, columns, missing, duplicateRows: integer(d.duplicateRows, 0, rows, "Duplicate rows"), ...(d.format === "jsonl" ? { schema: d.schema } : {}) };
}
export function intent(raw: unknown): Intent {
  const v = object(raw, ["version", "id", "workerId", "controllerId", "bundle", "kind", "createdAt", "deadline", "dataset", "spec", "source", "python", "recipe", "model", "modelPath", "search", "holdout"], "job intent");
  if (v.version !== 1 || !["training", "setup", "model", "holdout"].includes(v.kind)) throw new MlError("Unsupported job protocol");
  const selected = recipe(v.recipe);
  if (v.search !== undefined) {
    const search = object(v.search, ["cycleId", "partition", "fromJob"], "search binding"); id(search.cycleId);
    if (v.kind !== "training" || !["validation", "test"].includes(search.partition) || (search.partition === "test") !== (search.fromJob !== undefined)) throw new MlError("Invalid search phase");
    if (search.fromJob) { const source = object(search.fromJob, ["id", "modelHash"], "selected model"); id(source.id); digest(source.modelHash); if (source.id === v.id) throw new MlError("Invalid selected model"); }
  }
  id(v.id); id(v.workerId); id(v.controllerId); digest(v.bundle);
  integer(v.createdAt, 1, Number.MAX_SAFE_INTEGER, "Creation time");
  integer(v.deadline, v.createdAt + 1000, v.createdAt + 7200000, "Deadline");
  if (v.kind !== "holdout" && v.holdout !== undefined) throw new MlError("Only evaluation jobs may carry holdout inputs");
  if (v.kind === "holdout") {
    v.dataset = dataset(v.dataset); v.holdout = holdoutInput(v.holdout);
    if (v.spec || v.model || v.modelPath || v.source || v.search || v.holdout.candidate.workerId !== v.workerId || v.holdout.candidate.controllerId !== v.controllerId || v.holdout.candidate.bundle !== v.bundle || v.holdout.candidate.recipe !== selected || v.dataset.rows > 10000 || v.deadline - v.createdAt > 1800000 || (selected === LLM_RECIPE) !== (v.dataset.format === "jsonl")) throw new MlError("Invalid immutable holdout job");
  } else if (v.kind === "training") {
    v.dataset = dataset(v.dataset); v.spec = selected === LLM_RECIPE ? llmSpec(v.spec) : trainingSpec(v.spec);
    const source = object(v.source, ["commit", "project"], "source");
    if (!/^[a-f0-9]{40,64}$/.test(source.commit)) throw new MlError("Invalid source revision");
    string(source.project, "project");
    if (selected === LLM_RECIPE) {
      if (v.dataset.format !== "jsonl") throw new MlError("Fine-tuning needs a JSONL snapshot");
      v.model = modelSnapshot(v.model);
    } else {
      if (v.dataset.format === "jsonl" || v.model) throw new MlError("Tabular training needs CSV or Parquet");
      if (!v.dataset.columns.includes(v.spec.label) || v.spec.split.kind !== "random" && !v.dataset.columns.includes(v.spec.split.column)) throw new MlError("The selected column is absent from this snapshot");
      if (v.dataset.missing[v.spec.label]) throw new MlError("The target contains missing labels; prepare complete examples first");
    }
    if (v.modelPath !== undefined) throw new MlError("Training must use an immutable model snapshot");
  } else {
    if (v.dataset || v.spec || v.source || v.model) throw new MlError("Preparation cannot carry training inputs");
    if (v.kind === "model") { if (selected !== LLM_RECIPE || !string(v.modelPath, "model directory", 4096).startsWith("/")) throw new MlError("Choose an absolute model directory on the training computer"); }
    else if (v.modelPath !== undefined) throw new MlError("Setup cannot carry a model directory");
  }
  string(v.python, "Python executable", 4096);
  if (v.python !== "python3" && !v.python.startsWith("/")) throw new MlError("Use python3 or an absolute Python executable path");
  return v as Intent;
}

export function modelSnapshot(raw: unknown): ModelSnapshot {
  const v = object(raw, ["hash", "bytes", "parameters", "architecture", "contextLength", "files"], "model snapshot");
  digest(v.hash); integer(v.bytes, 1, 16 * 1024 ** 3, "Model bytes"); integer(v.parameters, 1, 8000000000, "Model parameters");
  if (!["llama", "qwen2", "qwen3", "gpt2"].includes(v.architecture)) throw new MlError("This model architecture is not supported by the LoRA recipe");
  integer(v.contextLength, 32, 10000000, "Model context"); integer(v.files, 2, 128, "Model files"); return v as ModelSnapshot;
}
export function llmSpec(raw: unknown): LlmSpec {
  const v = object(raw, ["task", "device", "gpu", "maxLength", "maxSteps", "rank", "learningRate", "accumulation", "seed", "cpus", "trainSeconds"], "fine-tuning configuration");
  if (v.task !== "sft" || !["cpu", "mps", "cuda"].includes(v.device)) throw new MlError("Choose a fine-tuning device");
  if (v.device === "cuda" ? typeof v.gpu !== "string" || !/^GPU-[a-fA-F0-9-]{8,80}$/.test(v.gpu) : v.gpu !== undefined) throw new MlError("Choose an explicit NVIDIA GPU for CUDA training");
  if (typeof v.learningRate !== "number" || !Number.isFinite(v.learningRate) || v.learningRate < 0.000001 || v.learningRate > 0.001) throw new MlError("Learning rate must be between 0.000001 and 0.001");
  return { task: "sft", device: v.device, ...(v.gpu ? { gpu: v.gpu } : {}), maxLength: integer(v.maxLength, 32, 2048, "Sequence length"), maxSteps: integer(v.maxSteps, 1, 2000, "Training steps"), rank: integer(v.rank, 4, 64, "LoRA rank"), learningRate: v.learningRate, accumulation: integer(v.accumulation, 1, 16, "Gradient accumulation"), seed: integer(v.seed ?? 42, 0, 2147483647, "Seed"), cpus: integer(v.cpus, 1, 32, "CPU threads"), trainSeconds: integer(v.trainSeconds, 10, 3600, "Training seconds") };
}
