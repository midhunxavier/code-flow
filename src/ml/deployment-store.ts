import { canonical, hash } from "../training-worker/files.js";
import { id, digest, integer, MlError, string } from "./model.js";
import { release, releaseInputs, servingConfig } from "./deployment-model.js";
import type { MlState } from "./store.js";
export function validateDeployments(s: MlState) {
  const fail = (): never => { throw new MlError("Invalid deployment history or release authority", 503); };
  if (!Array.isArray(s.deployments) || s.deployments.length > 32 || new Set(s.deployments.map(d => d.id)).size !== s.deployments.length) fail();
  const operations = new Set<string>(), names = new Set<string>();
  for (const d of s.deployments) {
    id(d.id); string(d.name, "deployment name", 100); integer(d.createdAt, 1, Number.MAX_SAFE_INTEGER, "Deployment time");
    const model = s.registry.find(m => m.id === d.modelId), name = canonical([d.project, d.name.toLowerCase()]);
    if (!model || model.project !== d.project || model.repo !== d.repo || names.has(name) || !Array.isArray(d.releases) || !d.releases.length || d.releases.length > 200 || !Array.isArray(d.history) || !d.history.length || d.history.length > 200 || d.history.length !== d.revision || typeof d.enabled !== "boolean") fail();
    if (d.cleanupPending !== undefined && (d.cleanupPending !== true || d.enabled || d.config.mode !== "persistent")) fail();
    names.add(name); id(d.target.id); id(d.target.workerId); digest(d.target.bundle); integer(d.target.revision, 1, Number.MAX_SAFE_INTEGER, "Deployment target revision");
    string(d.target.directory, "worker directory", 4096); string(d.target.python, "Python executable", 4096);
    if (!["local", "ssh"].includes(d.target.kind) || !(d.target.directory.startsWith("/") || d.target.kind === "ssh" && d.target.directory.startsWith("~/")) || d.target.python !== "python3" && !d.target.python.startsWith("/") || d.target.kind === "ssh" && (typeof d.target.host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,199}$/.test(d.target.host))) fail();
    if (new Set(d.releases.map(r => r.id)).size !== d.releases.length) fail();
    for (const r of d.releases) {
      release(r); const { id: releaseId, ...fields } = r;
      const v = model!.versions.find(v => v.id === r.versionId), job = s.experiments.find(e => e.id === v?.jobId);
      if (!job || hash(canonical(fields)) !== releaseId || r.controllerId !== s.controllerId || r.workerId !== d.target.workerId || r.bundle !== d.target.bundle || canonical(r.config) !== canonical(d.config)) fail();
      if (canonical(r) !== canonical({ id: releaseId, controllerId: s.controllerId, workerId: d.target.workerId, bundle: d.target.bundle, versionId: r.versionId, ...releaseInputs(job!), config: servingConfig(d.config, !!job!.intent.model) })) fail();
    }
    let current: string | undefined, enabled = false; const used = new Set<string>();
    for (const [i, h] of d.history.entries()) {
      id(h.operationId); digest(h.requestHash); string(h.reason, "deployment reason", 1000); integer(h.at, 1, Number.MAX_SAFE_INTEGER, "Deployment event time");
      if (operations.has(h.operationId) || h.from !== current || !d.releases.some(r => r.id === h.to) || !["deploy", "switch", "rollback", "stop", "resume"].includes(h.action) || (h.action === "deploy") !== (i === 0) || h.action === "rollback" && !used.has(h.to) || ["switch", "rollback"].includes(h.action) && current === h.to || ["stop", "resume"].includes(h.action) && (current !== h.to || (h.action === "stop") !== enabled) || typeof h.reviewed !== "boolean" || !Array.isArray(h.comparison) || h.comparison.length > 12 || h.comparison.some(c => typeof c !== "string" || c.length > 200) || h.comparison.length && !h.reviewed) fail();
      current = h.to; enabled = h.action !== "stop"; operations.add(h.operationId); used.add(h.to);
    }
    if (current !== d.current || enabled !== d.enabled || d.history.length === 200 && d.enabled || d.releases.some(r => !used.has(r.id))) fail();
  }
}
