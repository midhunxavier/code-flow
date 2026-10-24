import { streamInference } from "./inference-stream.js";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { HttpError, readJson, send } from "../http.js";
import { MlError, object, string } from "./model.js";
import type { MlService } from "./service.js";
/** Owner authentication and filesystem policy gating are established by the server. */
export async function handleMlApi(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], service: MlService) {
  if (parts[0] !== "ml") return false;
  const [, resource, id, action] = parts;
  try {
    if (parts.length > 4) throw new HttpError(404, "Unknown ML operation");
    if (resource === "capabilities" && parts.length === 2 && req.method === "GET") { send(res, 200, { enabled: service.enabled(), recipes: ["tabular-autogluon-v1", "llm-sft-lora-v1"], training: ["cpu", "mps", "cuda"], serving: ["on-demand", "persistent"], streaming: true, monitoring: true, promotion: true, commonHoldout: true, cloud: false }); return true; }
    if (resource === "summary" && parts.length === 2 && req.method === "GET") { send(res, 200, service.summary(string(url.searchParams.get("project"), "project"))); return true; }
    if (!resource && req.method === "GET") { send(res, 200, service.overview(string(url.searchParams.get("project"), "project"))); return true; }
    if (resource === "defaults" && !id && req.method === "POST") { send(res, 200, await service.setDefault(await readJson(req, 16000))); return true; }
    if (resource === "targets" && req.method === "POST") {
      if (!id) { send(res, 201, await service.register(await readJson(req, 16000))); return true; }
      if (action === "probe") { const body = object(await readJson(req, 16000), ["serving"]); if (body.serving !== undefined && typeof body.serving !== "boolean") throw new MlError("Invalid inference probe"); send(res, 200, await service.probe(id, body.serving === true)); return true; }
      if (action === "upgrade") { object(await readJson(req, 16000), []); send(res, 200, await service.upgrade(id)); return true; }
      if (action === "settings") { send(res, 200, await service.configure(id, await readJson(req, 16000))); return true; }
      if (action === "setup") { const body = object(await readJson(req, 16000), ["project", "repo", "operationId", "recipe"]); send(res, 202, await service.startJob({ ...body, target: id }, true)); return true; }
    }
    if (resource === "promotions") {
      if (!id && req.method === "POST") { send(res, 201, await service.promotions.create(await readJson(req, 16000))); return true; }
      if (id && ["pause", "resume", "check", "approve", "reject", "rollback"].includes(action!) && req.method === "POST") { send(res, 200, await service.promotions.update(id, action as "pause" | "resume" | "check" | "approve" | "reject" | "rollback", await readJson(req, 16000))); return true; }
    }
    if (resource === "monitors") {
      if (!id && req.method === "POST") { send(res, 201, await service.monitors.create(await readJson(req, 16000))); return true; }
      if (id && ["pause", "resume", "check", "reference"].includes(action!) && req.method === "POST") { send(res, 200, await service.monitors.update(id, action as "pause" | "resume" | "check" | "reference", await readJson(req, 16000))); return true; }
    }
    if (resource === "deployments") {
      if (id && action === "runtime" && req.method === "GET") { send(res, 200, await service.deployments.runtime(id)); return true; }
      if (id && action === "warm" && req.method === "POST") { object(await readJson(req, 16000), []); send(res, 200, await service.deployments.warm(id)); return true; }
      if (id && action === "stream" && req.method === "POST") { await streamInference(res, service, id, await readJson(req, 64000)); return true; }
      if (!id && req.method === "POST") { send(res, 201, await service.deployments.create(await readJson(req, 16000))); return true; }
      if (id && ["switch", "rollback", "stop", "resume"].includes(action!) && req.method === "POST") { send(res, 200, await service.deployments.update(id, action as "switch" | "rollback" | "stop" | "resume", await readJson(req, 16000))); return true; }
      if (id && action === "predict" && req.method === "POST") {
        const abort = new AbortController(), closed = () => { if (!res.writableEnded) abort.abort(); };
        res.on("close", closed);
        try { send(res, 200, await service.deployments.predict(id, await readJson(req, 64000), { signal: abort.signal })); }
        finally { res.off("close", closed); }
        return true;
      }
    }
    if (resource === "registry") {
      if (!id && req.method === "POST") { send(res, 201, await service.registry.register(await readJson(req, 16000))); return true; }
      if (id && !action && req.method === "GET") { send(res, 200, await service.registry.read(id, url.searchParams.get("reference") ?? undefined)); return true; }
      if (id && (action === "promote" || action === "rollback") && req.method === "POST") { send(res, 200, await service.registry.select(id, action, await readJson(req, 16000))); return true; }
    }
    if (resource === "versions" && id) {
      if (action === "restore" && req.method === "POST") { object(await readJson(req, 16000), []); send(res, 200, await service.registry.restore(id)); return true; }
      if (action === "export" && req.method === "GET") {
        await service.registry.withArchive(id, async (file, version, job) => {
          res.writeHead(200, { "content-type": "application/gzip", "content-length": job.status.artifact!.bytes, "content-disposition": `attachment; filename="codeflow-model-v${version.number}-${version.id}.tar.gz"`, "cache-control": "no-store", "x-codeflow-model-version": version.id, "x-codeflow-artifact-sha256": job.status.artifact!.hash });
          await pipeline(file.createReadStream({ start: 0, autoClose: false }), res);
        }); return true;
      }
    }
    if (resource === "schedules" && req.method === "POST") {
      if (!id) { send(res, 201, await service.schedules.create(await readJson(req, 64000))); return true; }
      if (action === "pause" || action === "resume" || action === "check") { send(res, 200, await service.schedules.update(id, action, await readJson(req, 16000))); return true; }
    }
    if (resource === "cycles" && req.method === "POST") {
      if (!id) { send(res, 202, await service.cycles.create(await readJson(req, 64000))); return true; }
      if (action === "stop" || action === "resume") { object(await readJson(req, 16000), []); send(res, 200, action === "stop" ? await service.cycles.stop(id) : await service.cycles.resume(id)); return true; }
    }
    if (resource === "models" && !id && req.method === "POST") { send(res, 202, await service.startJob(await readJson(req, 16000), "model")); return true; }
    if (resource === "datasets" && !id && req.method === "POST") { send(res, 201, await service.snapshot(await readJson(req, 16000))); return true; }
    if (resource === "experiments") {
      if (!id && req.method === "POST") { send(res, 202, await service.startJob(await readJson(req, 64000))); return true; }
      if (id && req.method === "POST" && ["inspect", "cancel"].includes(action!)) { object(await readJson(req, 16000), []); send(res, 200, action === "cancel" ? await service.cancel(id) : await service.inspect(id)); return true; }
      if (id && action === "logs" && req.method === "GET") { send(res, 200, await service.logs(id, Number(url.searchParams.get("cursor") ?? 0))); return true; }
      if (id && action === "export" && req.method === "GET") {
        const file = await service.export(id), info = await stat(file);
        res.writeHead(200, { "content-type": "application/gzip", "content-length": info.size, "content-disposition": `attachment; filename="codeflow-model-${id}.tar.gz"`, "cache-control": "no-store" });
        await pipeline(createReadStream(file), res); return true;
      }
    }
    throw new HttpError(404, "Unknown ML operation");
  } catch (error) { if (error instanceof MlError) throw new HttpError(error.status, error.message); throw error; }
}
