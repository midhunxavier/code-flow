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
    if (id === "defaults" && req.method === "GET" && parts.length === 3) {
      return send(res, 200, await service.draftDefaults(text(url.searchParams.get("project"), 100, "project"), text(url.searchParams.get("repo"), 4000, "repository")));
    }
    if (id === "definitions") {
      if (req.method === "GET" && parts.length === 3) return send(res, 200, { definitions: service.teamLibrary(), faults: Object.fromEntries(service.definitions.faults) });
      if (req.method === "GET" && parts.length === 4) return send(res, 200, service.definitions.get(parts[3]!));
      if (req.method === "POST" && (parts.length === 3 || parts.length === 4)) return send(res, parts.length === 3 ? 201 : 200, await service.saveDefinition(await readJson(req, 128 * 1024), parts[3]));
      throw new HttpError(405, "Use GET or POST for reusable agent teams");
    }
    if (id === "settings" && parts.length === 3) {
      if (req.method === "GET") return send(res, 200, service.configuration());
      if (req.method === "POST") return send(res, 200, await service.setEnabled(await readJson(req, 8192)));
      throw new HttpError(405, "Use GET or POST for project mission settings");
    }
    if (req.method === "GET" && !id) { const project = url.searchParams.get("project") ?? undefined; return send(res, 200, { ...service.configuration(), teams: service.list(project), definitions: service.teamLibrary(), definitionFaults: Object.fromEntries(service.definitions.faults), faults: Object.fromEntries(service.store.faults), faultDetails: service.store.faultDetails(), creationBlocked: service.store.creationProblem(), repositoryOwners: project ? await service.repositoryOwners(project) : {}, providers: (await agentAvailability()).map(({ id, displayName, available }) => ({ id, name: displayName, available, reason: providerEligibility(id, { trust: "standard", unattended: true, projectTeam: true }) })) }); }
    if (req.method === "GET" && id && parts.length === 3) { const team = service.store.get(id); return send(res, 200, { team, allowance: allowance(team) }); }
    if (req.method === "GET" && id && parts[3] === "preview" && parts.length === 4) return send(res, 200, await service.preview(id));
    if (req.method !== "POST") throw new HttpError(405, "Use GET or POST for project teams");
    const body = await readJson(req, 128 * 1024);
    if (!id) return send(res, 201, await service.create(body));
    if (parts.length === 3) return send(res, 200, await service.update(id, body));
    if (parts[3] === "cycle" && parts.length === 4) { closed(body, ["operationId"], "cycle request"); return send(res, 200, await service.cycle(id, text(body.operationId, 150, "operation ID"))); }
    if (parts[3] === "stop" && parts.length === 4) return send(res, 200, await service.stopCycle(id, body));
    if (parts[3] === "tasks" && parts.length === 4) return send(res, 201, await service.assignTask(id, body));
    if (parts[3] === "opportunities" && parts[4] && parts.length === 5) return send(res, 200, await service.decide(id, parts[4], body));
    throw new HttpError(404, "Unknown project team operation");
  } catch (error) { throw new HttpError((error as { status?: number }).status ?? 400, (error as Error).message); }
}
