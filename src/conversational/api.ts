import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, readJson, send } from "../http.js";
import { CliTeamError } from "../cli-teams/model.js";
import type { TaskConversations } from "./service.js";
/** Called behind the application's owner authentication, origin and file-policy gates. */
export async function handleTaskConversations(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], service: TaskConversations) {
    try {
        const id = parts[2];
        if (id === "models" && parts.length === 3 && req.method === "GET")
            return send(res, 200, await service.models(url.searchParams.get("project") ?? "", url.searchParams.get("repo") ?? "", url.searchParams.get("provider") as "claude" | "codex"));
        if (parts.length === 2 && req.method === "POST")
            return send(res, 201, await service.create(await readJson(req, 64 * 1024)));
        if (parts.length === 2 && req.method === "GET")
            return send(res, 200, await service.list(url.searchParams.get("project") ?? ""));
        if (id === "source" && parts.length === 3 && req.method === "GET")
            return send(res, 200, await service.sourceFiles(url.searchParams.get("project") ?? "", url.searchParams.get("repo") ?? ""));
        if (id && parts[3] === "execution" && parts.length === 4 && req.method === "GET") return send(res, 200, await service.readExecution(id, url.searchParams.get("runId") ?? ""));
        if (id && parts[3] === "source" && parts.length === 4 && req.method === "GET")
            return send(res, 200, await service.retainedSourceFiles(id));
        if (id && parts[3] === "approach" && parts.length === 4 && req.method === "GET")
            return send(res, 200, await service.approach(id, url.searchParams.get("proposalId") ?? "", Number(url.searchParams.get("revision"))));
        if (id && parts.length === 3 && req.method === "GET") {
            const controller = new AbortController(), stop = () => controller.abort();
            res.once("close", stop);
            try {
                const snapshot = await service.read(id, url.searchParams.get("after") ?? undefined, Math.min(25000, Math.max(0, Number(url.searchParams.get("wait")) || 0)), controller.signal);
                if (!res.destroyed)
                    send(res, 200, snapshot);
            }
            finally {
                res.off("close", stop);
            }
            return;
        }
        if (id && parts[3] === "actions" && parts.length === 4 && req.method === "POST")
            return send(res, 200, await service.action(id, await readJson(req, 64 * 1024)));
        if (id && parts[3] === "artifacts" && parts.length === 4 && req.method === "GET")
            return send(res, 200, await service.artifact(id, url.searchParams.get("runId") ?? "", url.searchParams.get("artifactId") ?? "", url.searchParams.get("sha256") ?? "", Number(url.searchParams.get("cursor")) || 0));
        throw new HttpError(404, "Unknown task conversation operation");
    }
    catch (e) {
        if (e instanceof CliTeamError)
            return send(res, ["revision_conflict", "acceptance_stale", "conflict", "snapshot_stale", "context_stale", "budget_exhausted"].includes(e.code) ? 409 : e.code === "scope_denied" ? 403 : e.code === "not_found" ? 404 : 400, { error: e.message, code: e.code });
        throw e;
    }
}
