import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, readJson, send } from "../http.js";
import { CliTeamError } from "../cli-teams/model.js";
import { digest } from "../cli-teams/model.js";
import type { Conversations } from "./chats.js";

export async function handleConversations(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], service: Conversations) {
  try {
    if (parts.length === 2 && req.method === "GET") {
      const items = await service.list(url.searchParams.get("project") ?? ""), cursor = digest(items);
      return send(res, 200, { cursor, ...(url.searchParams.get("after") === cursor ? {} : { items }) });
    }
    if (parts.length === 2 && req.method === "POST") return send(res, 201, await service.create(await readJson(req, 7 * 1024 * 1024)));
    if (parts.length === 3 && req.method === "GET") {
      const snapshot = await service.get(parts[2]!);
      return send(res, 200, url.searchParams.get("after") === snapshot.cursor ? { cursor: snapshot.cursor, unchanged: true } : snapshot);
    }
    if (parts.length === 4 && parts[3] === "actions" && req.method === "POST") return send(res, 200, await service.action(parts[2]!, await readJson(req, 7 * 1024 * 1024)));
    throw new HttpError(404, "Unknown chat operation");
  } catch (error) {
    if (error instanceof CliTeamError) return send(res, ["revision_conflict", "acceptance_stale", "conflict", "snapshot_stale", "context_stale", "budget_exhausted", "recovery_required"].includes(error.code) ? 409 : error.code === "scope_denied" ? 403 : error.code === "not_found" ? 404 : 400, { error: error.message, code: error.code });
    throw error;
  }
}
