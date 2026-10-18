import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, readJson, send } from "./http.js";
import { FilteredTasks, FilteredTaskError } from "./filtered-tasks.js";

/** Caller must establish owner identity and register its request with the filesystem activation barrier. */
export async function handleFilteredTasksApi(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], service: FilteredTasks): Promise<boolean> {
  if (parts[0] !== "filtered-tasks") return false;
  try {
    const id = parts[1];
    if (!id && parts.length === 1 && req.method === "GET") { send(res, 200, service.summaries(url.searchParams.get("project") ?? undefined)); return true; }
    if (!id && parts.length === 1 && req.method === "POST") { send(res, 202, await service.create(await readJson(req, 64 * 1024))); return true; }
    if (id && parts.length === 2 && req.method === "GET") { send(res, 200, await service.read(id)); return true; }
    if (id && parts.length === 2 && req.method === "DELETE") { const body = await readJson(req, 16 * 1024); send(res, 200, await service.delete(id, body.revision)); return true; }
    if (id && parts.length === 3 && req.method === "POST") {
      const body = await readJson(req, 16 * 1024);
      if (parts[2] === "preview-import") { send(res, 200, await service.preview(id)); return true; }
      if (parts[2] === "import") { send(res, 200, await service.import(id, body)); return true; }
      if (parts[2] === "cancel") { await service.cancel(id, body.revision); send(res, 200, service.summaries().find((job) => job.id === id)); return true; }
      if (parts[2] === "receipt") { await service.reconcile(id, body.revision); send(res, 200, service.summaries().find((job) => job.id === id)); return true; }
    }
    throw new HttpError(404, "Unknown filtered task operation");
  } catch (error) { if (error instanceof FilteredTaskError) throw new HttpError(error.status, error.message); throw error; }
}
