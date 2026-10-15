import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { agentAvailability, adapters, isAgentId, type AgentId } from "./adapters/index.js";
import { PORT } from "./config.js";
import { RunManager, type Pattern } from "./engine.js";
import { findPattern, patterns } from "./patterns/index.js";
import { listDirectories } from "./fs.js";

const manager = new RunManager();
const indexHtml = fileURLToPath(new URL("../public/index.html", import.meta.url));
const HOST = "127.0.0.1";
const allowedHosts = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  // Requiring JSON forces a CORS preflight, which this server never approves.
  if (!req.headers["content-type"]?.startsWith("application/json")) {
    throw new HttpError(415, "Expected application/json");
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new HttpError(413, "Body too large");
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

/** This server launches coding agents, so only accept requests from its own page. */
function checkOrigin(req: IncomingMessage) {
  if (!allowedHosts.has(req.headers.host ?? "")) throw new HttpError(403, "Bad Host header");
  const origin = req.headers.origin;
  if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ""))) throw new HttpError(403, "Cross-origin request refused");
}

function describePattern(p: Pattern) {
  const { run: _run, ...rest } = p;
  return rest;
}

async function validateRoles(pattern: Pattern, input: unknown): Promise<Record<string, AgentId[]>> {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const roles: Record<string, AgentId[]> = {};
  const needed = new Set<AgentId>();
  for (const spec of pattern.roles) {
    const value = raw[spec.id];
    const list = (Array.isArray(value) ? value : value ? [value] : []).filter(isAgentId);
    const agents = spec.multiple ? [...new Set(list)] : list.slice(0, 1);
    if (agents.length === 0 && !spec.optional) throw new HttpError(400, `Pick an agent for "${spec.label}"`);
    agents.forEach((a) => needed.add(a));
    roles[spec.id] = agents;
  }
  for (const agent of needed) {
    if (!(await adapters[agent].available())) {
      throw new HttpError(400, `${adapters[agent].displayName} (\`${adapters[agent].binary}\`) is not installed or not on PATH`);
    }
  }
  return roles;
}

function validateOptions(pattern: Pattern, input: unknown): Record<string, number | boolean> {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const options: Record<string, number | boolean> = {};
  for (const spec of pattern.options) {
    const value = raw[spec.id];
    if (spec.type === "boolean") {
      options[spec.id] = typeof value === "boolean" ? value : (spec.default as boolean);
    } else {
      const n = typeof value === "number" ? value : Number(value);
      const fallback = spec.default as number;
      const clamped = Number.isFinite(n) ? Math.min(spec.max ?? n, Math.max(spec.min ?? n, Math.round(n))) : fallback;
      options[spec.id] = clamped;
    }
  }
  return options;
}

function streamEvents(req: IncomingMessage, res: ServerResponse, runId: string) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const write = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  // Subscribe before replaying so nothing emitted in between is lost; the client de-dupes by seq.
  const unsubscribe = manager.subscribe(runId, write);
  for (const event of manager.events(runId)) write(event);
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  checkOrigin(req);
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(await readFile(indexHtml));
    return;
  }

  if (parts[0] !== "api") throw new HttpError(404, "Not found");

  if (req.method === "GET" && parts[1] === "agents") return send(res, 200, await agentAvailability());
  if (req.method === "GET" && parts[1] === "patterns") return send(res, 200, patterns.map(describePattern));
  if (req.method === "GET" && parts[1] === "fs") {
    const listing = await listDirectories(url.searchParams.get("path") ?? undefined, url.searchParams.get("hidden") === "1")
      .catch((err: NodeJS.ErrnoException) => {
        const status = err.code === "ENOENT" ? 404 : err.code === "EACCES" || err.code === "EPERM" ? 403 : 400;
        throw new HttpError(status, err.code === "ENOENT" ? "Folder not found" : err.message);
      });
    return send(res, 200, listing);
  }

  if (parts[1] === "runs") {
    const runId = parts[2];
    if (!runId) {
      if (req.method === "GET") return send(res, 200, manager.list());
      if (req.method === "POST") {
        const body = await readJson(req);
        const pattern = findPattern(String(body.pattern ?? ""));
        if (!pattern) throw new HttpError(400, "Unknown pattern");
        const task = String(body.task ?? "").trim();
        const repo = String(body.repo ?? "").trim();
        if (!task) throw new HttpError(400, "Describe the task");
        if (!repo.startsWith("/")) throw new HttpError(400, "Repository must be an absolute path");
        const run = await manager
          .start({
            pattern,
            task,
            repo,
            baseRef: body.baseRef ? String(body.baseRef) : undefined,
            roles: await validateRoles(pattern, body.roles),
            options: validateOptions(pattern, body.options),
          })
          .catch((err: Error) => {
            throw err instanceof HttpError ? err : new HttpError(400, err.message);
          });
        return send(res, 201, { id: run.id });
      }
    }

    const run = runId ? manager.get(runId) : undefined;
    if (!run) throw new HttpError(404, "Run not found");
    if (req.method === "GET" && parts.length === 3) return send(res, 200, run);
    if (req.method === "GET" && parts[3] === "events") return streamEvents(req, res, run.id);
    if (req.method === "POST" && parts[3] === "cancel") return send(res, 200, { cancelled: manager.cancel(run.id) });
  }

  throw new HttpError(404, "Not found");
}

createServer((req, res) => {
  handle(req, res).catch((err: Error) => {
    if (res.headersSent) return res.end();
    send(res, err instanceof HttpError ? err.status : 500, { error: err.message });
  });
}).listen(PORT, HOST, async () => {
  const agents = await agentAvailability();
  console.log(`code-flow running at http://localhost:${PORT}`);
  for (const a of agents) console.log(`  ${a.available ? "✓" : "✗"} ${a.displayName} (${a.binary})`);
});
