import { canonical, hash } from "../training-worker/files.js";
import { digest, id, integer, jobStatus, MlError, string, type Experiment } from "./model.js";
import { evaluatedModel, modelContract, type RegisteredModel } from "./registry-model.js";
export const REGISTRY_BYTES = 2 * 1024 ** 3;
/** Pins the full admitted training inputs, compute and final receipt without duplicating them. */
export function modelReceipt(e: Experiment) {
  return hash(canonical({ id: e.id, project: e.project, repo: e.repo, target: e.target, intent: e.intent, evaluation: e.status.evaluation, artifact: e.status.artifact, endedAt: e.status.endedAt ?? null }));
}
export function validateRegistry(models: RegisteredModel[], jobs: Experiment[]) {
  const fail = (message: string): never => { throw new MlError(message, 503); };
  if (!Array.isArray(models) || models.length > 32 || new Set(models.map(m => m.id)).size !== models.length) fail("Invalid model registry");
  if (models.some(m => !m || !Array.isArray(m.versions) || !Array.isArray(m.history) || typeof m.name !== "string")) fail("Invalid registry model record");
  const versions = models.flatMap(m => m.versions), operations = [...versions.map(v => v.operationId), ...models.flatMap(m => m.history.map(h => h.operationId))];
  if (versions.length > 200 || new Set(versions.map(v => v.id)).size !== versions.length || new Set(versions.map(v => v.jobId)).size !== versions.length || new Set(operations).size !== operations.length) fail("Duplicate or excessive registry identities");
  if (new Set(models.map(m => JSON.stringify([m.project, m.repo, m.name.toLowerCase()]))).size !== models.length) fail("Duplicate registry model name");
  let bytes = 0;
  for (const m of models) {
    id(m.id); string(m.project, "project"); string(m.repo, "repository", 4096); string(m.name, "model name", 100); integer(m.createdAt, 1, Number.MAX_SAFE_INTEGER, "Model creation time");
    if (!Array.isArray(m.versions) || !m.versions.length || !Array.isArray(m.history) || m.history.length > 200 || m.revision !== m.versions.length + m.history.length) fail("Invalid registry revision ledger");
    const first = jobs.find(e => e.id === m.versions[0]!.jobId);
    if (!first || !evaluatedModel(first)) fail("Registry requires final evaluated exports");
    for (const [index, v] of m.versions.entries()) {
      id(v.id); id(v.jobId); id(v.operationId); digest(v.requestHash); digest(v.receiptHash); integer(v.registeredAt, 1, Number.MAX_SAFE_INTEGER, "Version registration time");
      if (typeof v.notes !== "string" || v.notes.length > 1000 || /[\x00-\x1f\x7f]/.test(v.notes)) fail("Invalid version notes");
      const e = jobs.find(e => e.id === v.jobId);
      if (!e || !evaluatedModel(e) || e.project !== m.project || e.repo !== m.repo || e.registry?.modelId !== m.id || e.registry.versionId !== v.id || v.number !== index + 1 || modelReceipt(e) !== v.receiptHash || modelContract(e) !== modelContract(first!)) fail("Registry version receipt or model contract changed");
      jobStatus(e!.status); bytes += e!.status.artifact!.bytes;
    }
    let selected: string | undefined, revision = 0;
    const previouslySelected = new Set<string>();
    for (const h of m.history) {
      id(h.id); id(h.operationId); digest(h.requestHash); string(h.reason, "selection reason", 1000); integer(h.at, 1, Number.MAX_SAFE_INTEGER, "Selection time");
      if (!["promote", "rollback"].includes(h.action) || h.from !== selected || h.from === h.to || !m.versions.some(v => v.id === h.to && v.registeredAt <= h.at) || h.action === "rollback" && !previouslySelected.has(h.to) || !Number.isSafeInteger(h.revision) || h.revision <= revision || h.revision > m.revision || typeof h.reviewed !== "boolean" || !Array.isArray(h.comparison) || h.comparison.length > 12 || h.comparison.some(v => typeof v !== "string" || v.length > 200) || h.comparison.length && !h.reviewed) fail("Invalid model selection history");
      selected = h.to; revision = h.revision; previouslySelected.add(h.to);
    }
    if (m.selectedVersionId !== selected) fail("Selected model differs from its history");
  }
  if (bytes > REGISTRY_BYTES) fail("Registry archives exceed the 2 GiB retention limit");
  for (const e of jobs) if (e.registry && !models.some(m => m.id === e.registry!.modelId && m.versions.some(v => v.id === e.registry!.versionId && v.jobId === e.id))) fail("Missing model registry history");
}
