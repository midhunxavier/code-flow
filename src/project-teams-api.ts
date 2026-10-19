import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, readJson, send } from "./http.js";
import { ProjectTeams } from "./project-teams.js";
import { allowance, closed, text } from "./project-team-model.js";
import { agentAvailability } from "./adapters/index.js";
import { providerEligibility } from "./provider-eligibility.js";

/** Called only after the owner/session and filesystem access boundaries. */
export async function handleProjectTeams(service: ProjectTeams, req: IncomingMessage, res: ServerResponse, parts: string[], url: URL) {
  try {
    const id = parts[2];
    if (id === "settings" && parts.length === 3) {
      if (req.method === "GET") return send(res, 200, service.configuration());
      if (req.method === "POST") return send(res, 200, await service.setEnabled(await readJson(req, 8192)));
      throw new HttpError(405, "Use GET or POST for Standing teams settings");
    }
    if (req.method === "GET" && !id) return send(res, 200, { ...service.configuration(), teams: service.list(url.searchParams.get("project") ?? undefined), faults: Object.fromEntries(service.store.faults), providers: (await agentAvailability()).map(({ id, displayName, available }) => ({ id, name: displayName, available, reason: providerEligibility(id, { trust: "standard", unattended: true, projectTeam: true }) })) });
    if (req.method === "GET" && id && parts.length === 3) { const team = service.store.get(id); return send(res, 200, { team, allowance: allowance(team) }); }
    if (req.method === "GET" && id && parts[3] === "preview" && parts.length === 4) return send(res, 200, await service.preview(id));
    if (req.method !== "POST") throw new HttpError(405, "Use GET or POST for project teams");
    const body = await readJson(req, 128 * 1024);
    if (!id) return send(res, 201, await service.create(body));
    if (parts.length === 3) return send(res, 200, await service.update(id, body));
    if (parts[3] === "cycle" && parts.length === 4) { closed(body, ["operationId"], "cycle request"); return send(res, 200, await service.cycle(id, text(body.operationId, 150, "operation ID"))); }
    if (parts[3] === "stop" && parts.length === 4) return send(res, 200, await service.stopCycle(id, body));
    if (parts[3] === "opportunities" && parts[4] && parts.length === 5) return send(res, 200, await service.decide(id, parts[4], body));
    throw new HttpError(404, "Unknown project team operation");
  } catch (error) { throw new HttpError((error as { status?: number }).status ?? 400, (error as Error).message); }
}
