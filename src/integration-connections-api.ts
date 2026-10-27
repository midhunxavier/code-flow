import type { IncomingMessage, ServerResponse } from "node:http";
import { IntegrationConnections, repositoryConnectionHint } from "./integration-connections.js";
import type { Integrations } from "./integrations.js";
import type { Projects } from "./projects.js";
import { HttpError, readJson, send } from "./http.js";
import { listGitHubPicker, viewIssue, viewPullRequest, prChecks } from "./github.js";

/** Mounted after owner authorization and filesystem policy checks. Shared accounts never read server credentials. */
export function createIntegrationConnectionsApi(options: { connections: IntegrationConnections; integrations: Integrations; projects: Pick<Projects, "get"> }) {
  const { connections, integrations, projects } = options;
  const context = (projectId: unknown, repository: unknown) => {
    const project = typeof projectId === "string" ? projects.get(projectId) : undefined;
    if (!project) throw new HttpError(404, "Choose an existing project");
    if (typeof repository !== "string" || !project.repos.includes(repository)) throw new HttpError(400, "Choose a repository belonging to this project");
    return { projectId: project.id, repository };
  };
  return async (req: IncomingMessage, res: ServerResponse, url: URL, parts: string[]) => {
    if (parts[0] !== "integration-connections") return false;
    const body = req.method === "GET" ? {} : await readJson(req, 32 * 1024);
    let result: unknown;
    if (parts.length === 1 && req.method === "GET") result = { connections: connections.list(), warnings: connections.warnings() };
    else if (parts.length === 2 && parts[1] === "test" && req.method === "POST") {
      if (body.provider === "github") context(body.projectId, body.repository);
      result = await connections.testDraft(body);
    } else if (parts.length === 2 && parts[1] === "connect" && req.method === "POST") {
      result = await connections.connect(body.testId, body.projectId ? context(body.projectId, body.repository) : undefined);
    } else if (parts[1] === "projects" && parts[2]) {
      const project = projects.get(parts[2]); if (!project) throw new HttpError(404, "Project not found");
      const scope = context(project.id, req.method === "GET" ? url.searchParams.get("repository") : body.repository);
      if (parts.length === 3 && req.method === "GET") result = { connections: connections.list(), warnings: connections.warnings(), bindings: connections.bindings(project.id), suggestion: await repositoryConnectionHint(scope.repository) };
      else if (parts.length === 3 && req.method === "PUT") { await connections.associate({ ...scope, connectionId: body.connectionId }); result = { ok: true }; }
      else if (parts.length === 3 && req.method === "DELETE") { await connections.detach({ ...scope, connectionId: body.connectionId }); result = { ok: true }; }
      else if (parts.length === 5 && parts[3]) {
        const connection = connections.requireBinding({ ...scope, connectionId: parts[3] });
        const kind = req.method === "GET" ? url.searchParams.get("kind") : body.kind;
        if (kind !== "issue" && kind !== "pr") throw new HttpError(400, "Choose issues or pull requests");
        if (parts[4] === "items" && req.method === "GET") {
          if (connection.provider === "github") {
            const listed = await listGitHubPicker(scope.repository, kind === "issue" ? "issue" : "pr", url.searchParams.get("q") ?? "");
            result = { items: listed.items.map(item => ({ integration: connection.id, provider: "github", kind, key: String(item.number), title: item.title, body: item.body, url: item.url })), truncated: listed.truncated };
          } else result = await integrations.items(connection.id, kind, url.searchParams.get("cursor") ?? undefined);
        } else if (parts[4] === "import" && req.method === "POST") {
          if (connection.provider === "github") {
            if (typeof body.key !== "string" || !/^[1-9]\d{0,9}$/.test(body.key)) throw new HttpError(400, "Choose a valid issue or PR number");
            const number = Number(body.key), value = kind === "issue" ? await viewIssue(scope.repository, number) : await viewPullRequest(scope.repository, number);
            result = { project: project.id, repository: scope.repository, github: { ...value, kind }, ...(kind === "pr" ? { checks: await prChecks(scope.repository, body.key) } : {}) };
          } else result = { project: project.id, repository: scope.repository, source: await integrations.importSource(connection.id, kind, body.key, { project: project.id, repository: scope.repository }) };
        } else throw new HttpError(404, "Unknown project connection operation");
      } else throw new HttpError(404, "Unknown project connection operation");
    } else if (parts.length === 3 && parts[2] === "test" && req.method === "POST") result = await connections.testExisting(parts[1]!);
    else if (parts.length === 2 && req.method === "DELETE") { await connections.disconnect(parts[1]!); result = { ok: true }; }
    else throw new HttpError(404, "Unknown connection operation");
    send(res, 200, result); return true;
  };
}
