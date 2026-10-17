import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** A transport capability authorizes one active member attempt, never a user or a whole run. */
export interface TeamToolIdentity {
  runId: string;
  memberId: string;
  taskId?: string;
  attempt?: number;
  stepId?: string;
  attemptId: string;
}

/** Secret transport data: never put this in a Run, prompt, journal, event, or log. */
export interface TeamToolConnection { endpoint: string; token: string; expiresAt: number }
export type TeamToolName =
  | "send_message" | "ask_member" | "reply_request" | "yield_task"
  | "publish_finding" | "propose_contract" | "submit_task" | "request_help"
  | "read_inbox" | "read_memory" | "write_memory" | "propose_project_memory";
export interface TeamToolRequest { name: TeamToolName; arguments: Record<string, unknown> }
export interface TeamToolDefinition { name: TeamToolName; description: string; inputSchema: Record<string, unknown>; annotations: { readOnlyHint: boolean; destructiveHint: false; idempotentHint: true; openWorldHint: false } }

const text = (maxLength = 6_000) => ({ type: "string", minLength: 1, maxLength });
const strings = (maxItems = 20) => ({ type: "array", maxItems, items: text(1_000) });
const operationId = text(160);
function tool(name: TeamToolName, description: string, properties: Record<string, unknown>, required: string[] = []): TeamToolDefinition {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false }, annotations: { readOnlyHint: name === "read_inbox" || name === "read_memory", destructiveHint: false, idempotentHint: true, openWorldHint: false } };
}

export const TEAM_TOOLS: readonly TeamToolDefinition[] = [
  tool("send_message", "Send a fact to a teammate. Returns after persistence; delivery may be live or at their next turn. Keep operationId stable on retries.", { operationId, recipient: text(40), body: text(), evidence: strings(16) }, ["operationId", "recipient", "body"]),
  tool("ask_member", "Ask a teammate or user. Returns a request ID immediately, never waits for an answer. If blocked, checkpoint and yield through your structured outcome.", { operationId, recipient: text(40), body: text(), blocking: { type: "boolean" }, deadlineMs: { type: "integer", minimum: 1_000, maximum: 3_600_000 }, evidence: strings(16) }, ["operationId", "recipient", "body"]),
  tool("reply_request", "Answer an addressed request with evidence. This is agent data and cannot authorize user-only actions.", { operationId, requestId: text(200), body: text(), evidence: strings(16) }, ["operationId", "requestId", "body", "evidence"]),
  tool("yield_task", "Persist a checkpoint and mark this task waiting. Then finish the current turn with a structured needs_info outcome so its process slot is released.", { operationId, checkpoint: text(12_000) }, ["operationId", "checkpoint"]),
  tool("publish_finding", "Publish a team finding with source evidence; this does not promote project memory.", { operationId, title: text(200), body: text(), evidence: strings(16), paths: strings() }, ["operationId", "title", "body", "evidence"]),
  tool("propose_contract", "Propose a team contract for coordinator validation. A proposal does not change user requirements or grant permissions.", { operationId, title: text(200), body: text(), evidence: strings(16) }, ["operationId", "body", "evidence"]),
  tool("submit_task", "Record a submission checkpoint and artifacts. Finish with your structured outcome; only the engine's checks and independent review can complete the task.", { operationId, checkpoint: text(12_000), artifacts: strings() }, ["operationId", "checkpoint"]),
  tool("request_help", "Ask the coordinator to resolve a blocker. Returns immediately; checkpoint and yield when no safe independent work remains.", { operationId, recipient: text(40), body: text(), evidence: strings(16) }, ["operationId", "body"]),
  tool("read_inbox", "Read only messages addressed to this member or the team. An inbox read is not an answer or a claim of comprehension.", { afterId: text(200), limit: { type: "integer", minimum: 1, maximum: 50 } }),
  tool("read_memory", "Read bounded memory selected for this member's current run and task. Private memory is restricted to this member; project entries retain provenance and applicability.", { scope: { enum: ["private", "team", "project"] }, query: text(1_000), limit: { type: "integer", minimum: 1, maximum: 20 } }, ["scope"]),
  tool("write_memory", "Save private notes or propose team notes with run-derived provenance. Team proposals stay unaccepted; publish_finding shares immediate findings. This cannot create accepted project conventions or export private notes.", { operationId, scope: { enum: ["private", "team"] }, title: text(200), body: text(12_000), tags: strings(), paths: strings() }, ["operationId", "scope", "title", "body"]),
  tool("propose_project_memory", "Propose a reusable project lesson for later review. Acceptance, trust, and repository applicability remain controlled by the server and user.", { operationId, title: text(200), body: text(12_000), tags: strings(), paths: strings() }, ["operationId", "title", "body"]),
];

const definitions = new Map(TEAM_TOOLS.map((value) => [value.name, value]));
const MAX_BODY = 64 * 1024;
const MAX_RESPONSE = 128 * 1024;
/** A step may run for up to 24 hours (CODEFLOW_STEP_TIMEOUT_MIN); the capability must outlive it, revocation ends it sooner. */
const MAX_TTL = 25 * 60 * 60_000;
type Handler = (request: TeamToolRequest, identity: Readonly<TeamToolIdentity>) => Promise<unknown>;
interface Grant {
  identity: Readonly<TeamToolIdentity>;
  path: string;
  expiresAt: number;
  handler: Handler;
  isActive?: () => boolean;
  pending: number;
}

/** Validate the closed wire schema before domain handlers see data. Identity is never an argument. */
export function validateTeamToolRequest(value: unknown): TeamToolRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid tool request");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "name" && key !== "arguments")) throw new Error("Unexpected tool request field");
  const definition = definitions.get(input.name as TeamToolName);
  if (!definition) throw new Error("Unknown team tool");
  const args = input.arguments ?? {};
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be an object");
  const schema = definition.inputSchema;
  const fields = schema.properties as Record<string, any>;
  for (const key of Object.keys(args)) if (!Object.hasOwn(fields, key)) throw new Error(`Unexpected argument: ${key}`);
  for (const key of schema.required as string[]) if (!Object.hasOwn(args, key)) throw new Error(`Missing argument: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const field = fields[key];
    if (field.enum && !field.enum.includes(value)) throw new Error(`Invalid argument: ${key}`);
    if (field.type === "string" && (typeof value !== "string" || !value.trim() || value.length > field.maxLength)) throw new Error(`Invalid argument: ${key}`);
    if (field.type === "boolean" && typeof value !== "boolean") throw new Error(`Invalid argument: ${key}`);
    if (field.type === "integer" && (typeof value !== "number" || !Number.isSafeInteger(value) || value < field.minimum || value > field.maximum)) throw new Error(`Invalid argument: ${key}`);
    if (field.type === "array" && (!Array.isArray(value) || value.length > field.maxItems || value.some((item) => typeof item !== "string" || !item.trim() || item.length > field.items.maxLength))) throw new Error(`Invalid argument: ${key}`);
  }
  return { name: definition.name, arguments: args as Record<string, unknown> };
}

/** A private loopback service; no general HTTP route or CODEFLOW_TOKEN is delegated to workers. */
export class TeamToolBridge {
  private server?: Server;
  private listening?: Promise<string>;
  private readonly grants = new Map<string, Grant>();

  async issue(options: {
    identity: TeamToolIdentity;
    handler: Handler;
    ttlMs?: number;
    signal?: AbortSignal;
    isActive?: () => boolean;
  }): Promise<{ connection: TeamToolConnection; revoke: () => void }> {
    const { identity } = options;
    if (!identity.runId || !identity.memberId || !identity.attemptId) throw new Error("A team capability requires a run, member and attempt");
    if (options.signal?.aborted) throw new Error("Cannot issue a team capability for a stopped turn");
    const base = await this.listen();
    if (options.signal?.aborted) throw new Error("Cannot issue a team capability for a stopped turn");
    const token = randomBytes(32).toString("base64url");
    const key = digest(token);
    const path = `/v1/runs/${encodeURIComponent(identity.runId)}/members/${encodeURIComponent(identity.memberId)}/attempts/${encodeURIComponent(identity.attemptId)}`;
    const ttl = typeof options.ttlMs === "number" && Number.isFinite(options.ttlMs) ? Math.max(1, Math.min(MAX_TTL, options.ttlMs)) : 30 * 60_000;
    const expiresAt = Date.now() + ttl;
    this.grants.set(key, { identity: Object.freeze({ ...identity }), path, expiresAt, handler: options.handler, isActive: options.isActive, pending: 0 });
    let timer: NodeJS.Timeout;
    const revoke = () => {
      this.grants.delete(key);
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", revoke);
    };
    timer = setTimeout(revoke, ttl);
    timer.unref();
    options.signal?.addEventListener("abort", revoke, { once: true });
    return { connection: { endpoint: base + path, token, expiresAt }, revoke };
  }

  async close(): Promise<void> {
    this.grants.clear();
    const server = this.server;
    this.server = undefined;
    this.listening = undefined;
    if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }

  private listen(): Promise<string> {
    if (this.listening) return this.listening;
    const server = createServer((req, res) => { void this.handle(req, res); });
    this.server = server;
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    server.maxHeadersCount = 30;
    this.listening = new Promise<string>((resolve, reject) => {
      // A failed listen (EMFILE, EACCES) must not pin every later turn to that failure.
      server.once("error", (error) => { this.listening = undefined; this.server = undefined; reject(error); });
      server.listen(0, "127.0.0.1", () => {
        server.unref();
        const address = server.address();
        if (!address || typeof address === "string") { reject(new Error("Could not start team bridge")); return; }
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
    return this.listening;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      const json = JSON.stringify(body ?? null);
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(json.length <= MAX_RESPONSE ? json : JSON.stringify({ error: "Tool response exceeded its context limit" }));
    };
    if (req.method !== "POST" || req.headers.origin || req.headers["content-type"] !== "application/json") { reply(403, { error: "Forbidden team bridge request" }); return; }
    const auth = req.headers.authorization;
    const token = typeof auth === "string" && /^Bearer [A-Za-z0-9_-]{43}$/.test(auth) ? auth.slice(7) : "";
    const grant = token ? this.grants.get(digest(token)) : undefined;
    if (!grant || req.url !== grant.path || grant.expiresAt <= Date.now() || grant.isActive?.() === false) { reply(403, { error: "Invalid or expired member capability" }); return; }
    if (grant.pending >= 4) { reply(429, { error: "Too many active member commands" }); return; }
    grant.pending++;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) { reply(413, { error: "Team command is too large" }); return; }
        chunks.push(chunk);
      }
      // Recheck revocation after reading the body; a slow client cannot outlive its turn.
      if (this.grants.get(digest(token)) !== grant || grant.expiresAt <= Date.now() || grant.isActive?.() === false) { reply(403, { error: "Invalid or expired member capability" }); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body?.method === "tools/list" && Object.keys(body).length === 1) { reply(200, { tools: TEAM_TOOLS }); return; }
      const request = validateTeamToolRequest(body);
      const value = await grant.handler(request, grant.identity);
      reply(200, { result: value ?? null });
    } catch (error) {
      // Domain errors are useful, but never include transport credentials in diagnostics.
      const message = error instanceof Error ? error.message : "Team command failed";
      reply(message.includes("no longer active") ? 403 : 400, { error: message.replaceAll(token, "[redacted]").slice(0, 1_000) });
    } finally { grant.pending--; }
  }
}

function digest(token: string): string { return createHash("sha256").update(token).digest("hex"); }
export const teamToolBridge = new TeamToolBridge();
