import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  agentAvailability,
  agentCatalog,
  adapters,
  isAgentId,
  validateAgentSettings,
  type AgentId,
} from "./adapters/index.js";
import { listTree, searchFiles } from "./repo-tree.js";
import { doctor } from "./doctor.js";
import { readRepoConfig } from "./repo-config.js";
import { openFolder } from "./serve.js";
import { CODEFLOW_HOME, PORT } from "./config.js";
import { RunManager, UntrustedSourceError, type LoopSettings, type Pattern } from "./engine.js";
import { detectCheckCommand } from "./checks.js";
import { findPattern, patterns } from "./patterns/index.js";
import { listDirectories } from "./fs.js";
import { listBranches, repoRoot, worktreeRoot } from "./git.js";
import { folderSizes, remoteBranches, removeWorktrees } from "./ship.js";
import { computeStats, rankAgents } from "./stats.js";
import { acquireLock, writeHealth } from "./store.js";
import { listIssues, listPullRequests, type SourceInput } from "./github.js";
import { listSweep, runSweep, type SweepKind } from "./sweeps.js";
import { resolveAuto } from "./routing.js";
import { templates } from "./templates.js";
import { PrWatcher } from "./watch.js";
import { Automations, describeSchedule, readWebhook, validateSchedule } from "./automation.js";
import { lanAddresses, loadRemote, newToken, renderRemote, saveRemote, tokenMatches, type RemoteSettings } from "./remote.js";
import { projectOf, Projects } from "./projects.js";
import type { Run, StartRunInput } from "./engine.js";

// One server per CODEFLOW_HOME (waits for one that is still shutting down).
const releaseLock = await acquireLock().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
process.once("exit", releaseLock);

const projects = new Projects();
const manager = new RunManager(findPattern, projects);
const watcher = new PrWatcher(manager);
const automations = new Automations(manager, (body, extra) => startFromBody(body, extra), (repo, kind) => listSweep(repo, kind, manager.list()));
let remote: RemoteSettings;
const REMOTE_PORT = Number(process.env.CODEFLOW_REMOTE_PORT ?? PORT + 1);
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

// Run requests can carry base64 attachments (up to 25 MB of files).
const MAX_BODY_BYTES = 40 * 1024 * 1024;

async function readJson(req: IncomingMessage): Promise<any> {
  // Requiring JSON forces a CORS preflight, which this server never approves.
  if (!req.headers["content-type"]?.startsWith("application/json")) {
    throw new HttpError(415, "Expected application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request too large: attached files must total under 25 MB");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
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

/**
 * Who may use the API. The Host/Origin checks stop web pages, but not programs on this machine
 * — including the agents code-flow runs, some of which are sandboxed with network access and
 * could otherwise ask this server to run a command outside their sandbox. So the API needs a
 * session cookie that only a browser holds.
 *
 * The token lives only in this process's memory. The first browser to open code-flow gets the
 * cookie ("claims" it) — until the moment code-flow first starts an agent, a check, or an app,
 * after which nothing on this machine that isn't already signed in can claim it. Any other
 * browser uses the link printed at startup (`/?token=…`). Scripts can send the token as a
 * Bearer header.
 */
const auth = {
  token: process.env.CODEFLOW_TOKEN || randomBytes(24).toString("hex"),
  claimable: true,
};
manager.onActivity(() => (auth.claimable = false));
const COOKIE = "codeflow_session";

function sessionCookie(): string {
  return `${COOKIE}=${auth.token}; HttpOnly; SameSite=Strict; Path=/`;
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const cookie = String(req.headers.cookie ?? "")
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  return cookie?.slice(name.length + 1);
}

function signedIn(req: IncomingMessage): boolean {
  const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (bearer && tokenMatches(bearer, auth.token)) return true;
  const cookie = readCookie(req, COOKIE);
  return !!cookie && tokenMatches(cookie, auth.token);
}

/**
 * Phones sign in with the phone link instead, when full control from the phone is on: opening
 * `/r/<token>` on the network listener sets this cookie and opens the app. The phone token is
 * saved in remote.json, so the phone stays signed in across restarts until you make a new link
 * or turn phone control off. The name carries the port because cookies ignore ports, and a
 * second code-flow on this machine has a link of its own.
 */
const PHONE_COOKIE = `codeflow_phone_${REMOTE_PORT}`;
const phoneControl = (s: RemoteSettings = remote) => s.enabled && s.lan && s.control;

function phoneCookie(): string {
  return `${PHONE_COOKIE}=${remote.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${400 * 86_400}`;
}

function phoneSignedIn(req: IncomingMessage): boolean {
  const cookie = readCookie(req, PHONE_COOKIE);
  return phoneControl() && !!cookie && tokenMatches(cookie, remote.token);
}

/**
 * The network listener has no fixed host name to check (Wi-Fi addresses change, VPNs add their
 * own), so it only refuses cross-origin requests. A page that rebinds its own name to this
 * address still can't use it: the phone's cookie belongs to the address it signed in on.
 */
function checkLanOrigin(req: IncomingMessage) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) throw new HttpError(403, "Cross-origin request refused");
}

const lockedPage = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>code-flow — ${title}</title><style>
:root{--bg:#f7f7f5;--text:#222f30;--muted:#445e5f;--panel:#fdfdfc;--border:#e4e3e3}
@media (prefers-color-scheme:dark){:root{--bg:#111918;--text:#f5f8f7;--muted:#c9cbbe;--panel:#192425;--border:#2b3a3c}}
body{margin:0;padding:0 16px;background:var(--bg);color:var(--text);font:15px/1.55 Manrope,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:520px;margin:12vh auto;padding:28px;background:var(--panel);border:1px solid var(--border);border-radius:24px;box-shadow:0 12px 30px rgba(34,47,48,.06),0 2px 10px rgba(34,47,48,.04)}
h1{font-size:22px;letter-spacing:-.03em;margin:0 0 10px}p{color:var(--muted);margin:8px 0}code{font:13px ui-monospace,Menlo,monospace}
</style></head><body><main>${body}</main></body></html>`;

const LOCKED_PAGE = lockedPage(
  "sign in",
  `<h1>Open code-flow from its link</h1>
<p>This code-flow server is already in use, so it only accepts browsers that open it with its link.</p>
<p>Find the line <code>Open http://localhost:${PORT}/?token=…</code> where code-flow was started (the terminal, or the preview's server log) and open that link here.</p>
<p>Restarting code-flow and reloading this page also works, as long as no run has started yet.</p>`,
);

const PHONE_LOCKED_PAGE = lockedPage(
  "scan the QR code",
  `<h1>Scan the QR code again</h1>
<p>This phone isn't signed in to code-flow. On your computer, open code-flow's <b>Automations</b> page and scan the QR code under <b>Phone</b>.</p>
<p>Making a new link, or turning off full control from your phone, signs phones out.</p>`,
);

/** Run an action whose errors are the user's to fix (shown as 400 with the message). */
async function attempt<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw err instanceof HttpError ? err : new HttpError(400, (err as Error).message);
  }
}

async function requestedRepo(url: URL): Promise<string> {
  const requested = url.searchParams.get("repo") ?? "";
  if (!requested.startsWith("/")) throw new HttpError(400, "Repository must be an absolute path");
  return repoRoot(requested).catch(() => {
    throw new HttpError(400, "Not a git repository");
  });
}

function describePattern(p: Pattern) {
  const { run: _run, ...rest } = p;
  return rest;
}

/** The agents (or "auto") asked for in each of the pattern's roles. */
function requestedRoles(pattern: Pattern, input: unknown): Record<string, string[]> {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const requested: Record<string, string[]> = {};
  for (const spec of pattern.roles) {
    const value = raw[spec.id];
    const list = (Array.isArray(value) ? value : value ? [value] : []).filter((v): v is string => v === "auto" || isAgentId(v));
    requested[spec.id] = spec.multiple ? list.slice(0, 6) : list.slice(0, 1);
  }
  return requested;
}

/** Who fills each role; "auto" picks an installed agent whose plan has room (see routing.ts). */
async function validateRoles(pattern: Pattern, input: unknown, repo?: string): Promise<{ roles: Record<string, AgentId[]>; notes: string[] }> {
  const requested = requestedRoles(pattern, input);
  const installed = new Set((await agentAvailability()).filter((a) => a.available).map((a) => a.id));
  const wantsAuto = Object.values(requested).some((list) => list.includes("auto"));
  const rank = wantsAuto && repo ? rankAgents(manager.list(), repo) : undefined;
  const resolved = resolveAuto(requested, manager.quota, installed, rank);
  const roles: Record<string, AgentId[]> = {};
  const needed = new Set<AgentId>();
  for (const spec of pattern.roles) {
    const list = resolved.roles[spec.id] ?? [];
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
  return { roles, notes: resolved.notes };
}

/** { kind: "issue" | "pr", number, ciLogs? } or { kind: "alert", tool, number, numbers? } — where a run starts from on GitHub. */
function validateSource(input: unknown): SourceInput | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const number = Number(raw.number);
  if (raw.kind !== "issue" && raw.kind !== "pr" && raw.kind !== "alert") throw new HttpError(400, "Source must be an issue, a pull request or an alert");
  if (!Number.isInteger(number) || number < 1) throw new HttpError(400, "Source needs an issue, PR or alert number");
  if (raw.kind !== "alert") return { kind: raw.kind, number, ciLogs: raw.ciLogs === true };
  if (raw.tool !== "dependabot" && raw.tool !== "code-scanning") throw new HttpError(400, "An alert comes from Dependabot or code scanning");
  const numbers = Array.isArray(raw.numbers) ? [...new Set(raw.numbers.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 50) : [];
  return { kind: "alert", tool: raw.tool, number, numbers: numbers.length ? numbers : undefined };
}

const SWEEP_KINDS: SweepKind[] = ["issues", "dependabot", "alerts"];
/** Most runs one sweep starts at once; agents and checks still queue behind CODEFLOW_MAX_AGENTS/CHECKS. */
const MAX_SWEEP = 25;

/**
 * Start a sweep: one run per item, each starting from its issue, PR or alert, with its result in
 * the inbox. `run` is the composer's run request (team, check, settings) shared by every item.
 * With a schedule, the sweep is also saved as an automation that starts runs for new items.
 */
async function startSweep(body: Record<string, any>) {
  const kind = body.kind as SweepKind;
  if (!SWEEP_KINDS.includes(kind)) throw new HttpError(400, "Unknown kind of sweep");
  const name = String(body.name ?? "").trim().slice(0, 80) || "Sweep";
  const base = body.run && typeof body.run === "object" ? body.run : {};
  const items: { key: string; task: string; source: SourceInput }[] = [];
  for (const i of Array.isArray(body.items) ? body.items : []) {
    const item = { key: String(i?.key ?? "").slice(0, 200), task: String(i?.task ?? "").trim().slice(0, 4_000), source: validateSource(i?.source) };
    if (!item.key || !item.task || !item.source) throw new HttpError(400, "Every item needs a task and a source");
    items.push({ ...item, source: item.source });
  }
  if (!items.length) throw new HttpError(400, "Pick at least one item");
  if (items.length > MAX_SWEEP) throw new HttpError(400, `Pick at most ${MAX_SWEEP} items; the rest can go in a later sweep`);
  const repo = (await buildStartInput({ ...base, task: items[0]!.task })).repo; // same checks as one run, before any starts
  const root = await repoRoot(repo);
  const schedule = body.schedule ? await attempt(async () => validateSchedule(body.schedule)) : undefined;
  const id = `s-${randomBytes(4).toString("hex")}`;
  const saved = schedule
    ? await automations.create({ name, enabled: true, run: { ...automationRun({ ...base, task: templates.find((t) => t.sweep === kind)?.task ?? name }), source: undefined }, schedule, webhook: false, isolate: false, sweep: { kind, max: Math.min(10, Math.max(1, Number(body.max) || 5)) } })
    : undefined;
  const trigger = { id: saved?.id ?? id, name, via: "sweep" as const };
  const outcome = await runSweep({
    repo: root,
    items,
    runs: manager.list(),
    start: (item) => startFromBody({ ...base, task: item.task, source: item.source }, { trigger }),
  });
  if (saved) await automations.markHandled(saved.id, outcome.started.map((s) => s.key));
  return { sweep: trigger.id, automation: saved?.id, ...outcome };
}

/** Per-role model/effort overrides: { role: { agent: { model, effort } } }, each validated like agentSettings. */
function validateRoleSettings(input: unknown): Record<string, ReturnType<typeof validateAgentSettings>> {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: Record<string, ReturnType<typeof validateAgentSettings>> = {};
  for (const [role, settings] of Object.entries(raw)) {
    if (!/^[\w-]{1,40}$/.test(role)) continue;
    try {
      const valid = validateAgentSettings(settings);
      if (Object.keys(valid).length) out[role] = valid;
    } catch (err) {
      throw new HttpError(400, `${role}: ${(err as Error).message}`);
    }
  }
  return out;
}

/** "Done when" check and budgets from the client; commands are the user's own shell commands. */
function validateLoop(input: unknown): Partial<LoopSettings> {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const text = (key: string) => {
    const value = typeof raw[key] === "string" ? (raw[key] as string).trim() : "";
    if (value.length > 1_000) throw new HttpError(400, `${key} command is too long`);
    if (/[\r\n]/.test(value)) throw new HttpError(400, `${key} command must be a single line`);
    return value || undefined;
  };
  const number = (key: string, min: number, max: number) => {
    const n = Number(raw[key]);
    return raw[key] === undefined || raw[key] === "" || !Number.isFinite(n) ? undefined : Math.min(max, Math.max(min, n));
  };
  return {
    check: text("check"),
    setup: text("setup"),
    copy: Array.isArray(raw.copy) ? raw.copy.filter((p): p is string => typeof p === "string" && !!p.trim()).slice(0, 50) : undefined,
    maxMinutes: number("maxMinutes", 1, 720),
    maxSteps: number("maxSteps", 1, 200),
    checkTimeoutMin: number("checkTimeoutMin", 1, 120),
  };
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

/** Validate a run request (from the composer or an automation) into what the engine starts. */
async function buildStartInput(body: Record<string, any>): Promise<StartRunInput> {
  const pattern = findPattern(String(body.pattern ?? ""));
  if (!pattern) throw new HttpError(400, "Unknown pattern");
  const task = String(body.task ?? "").trim();
  const repo = String(body.repo ?? "").trim();
  if (!task) throw new HttpError(400, "Describe the task");
  if (!repo.startsWith("/")) throw new HttpError(400, "Repository must be an absolute path");
  const { roles, notes } = await validateRoles(pattern, body.roles, await repoRoot(repo).catch(() => repo));
  const loop = validateLoop(body.loop);
  const container = body.loop?.container;
  if (container && typeof container.image === "string" && /^[\w./:@-]{1,200}$/.test(container.image)) {
    loop.container = { image: container.image, network: container.network !== false };
  }
  return {
    pattern,
    task,
    repo,
    project: typeof body.project === "string" && body.project ? body.project : undefined,
    baseRef: body.baseRef ? String(body.baseRef) : undefined,
    branchPrefix: body.branchPrefix ? String(body.branchPrefix) : undefined,
    context: body.context && typeof body.context === "object" ? body.context : undefined,
    loop,
    approvals: { plan: body.approvals?.plan === true },
    parentRunId: typeof body.parentRunId === "string" && manager.get(body.parentRunId) ? body.parentRunId : undefined,
    trust: ["safe", "standard", "trusted"].includes(body.trust) ? body.trust : undefined,
    roleSettings: validateRoleSettings(body.roleSettings),
    agentSettings: (() => {
      try {
        return validateAgentSettings(body.agentSettings);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    })(),
    source: validateSource(body.source),
    allowUntrusted: body.allowUntrusted === true,
    routing: notes,
    roles,
    options: validateOptions(pattern, body.options),
  };
}

async function startFromBody(body: Record<string, any>, extra: { trigger?: Run["trigger"]; group?: Run["group"] } = {}): Promise<Run> {
  const input = await buildStartInput(body);
  return manager.start({ ...input, ...extra }).catch((err: Error) => {
    if (err instanceof UntrustedSourceError) throw Object.assign(new HttpError(409, err.message), { confirm: "allowUntrusted" });
    throw err instanceof HttpError ? err : new HttpError(400, err.message);
  });
}

/** The parts of a run request an automation keeps (no attachments: they'd go stale). */
function automationRun(body: Record<string, any>) {
  const keep = ["repo", "project", "pattern", "task", "roles", "options", "baseRef", "loop", "trust", "agentSettings", "roleSettings", "source"];
  const run: Record<string, any> = Object.fromEntries(keep.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
  if (Array.isArray(body.context?.paths)) run.context = { paths: body.context.paths.map((p: any) => ({ path: String(p.path ?? "") })) };
  return run as { repo: string; pattern: string; task: string };
}

function describeAutomation(t: ReturnType<typeof automations.list>[number]) {
  return { ...t, scheduleText: describeSchedule(t.schedule), hookPath: `/hooks/${t.id}` };
}

/** Unauthenticated-origin routes with their own tokens: webhooks and the phone link. */
async function handlePublic(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], via: Via): Promise<boolean> {
  if (parts[0] === "hooks" && parts[1] && req.method === "POST") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new HttpError(413, "Payload too large");
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    let trigger;
    try {
      trigger = automations.authorize(parts[1], req.headers, raw);
    } catch (err) {
      throw new HttpError((err as { status?: number }).status ?? 401, (err as Error).message);
    }
    if (req.headers["x-github-event"] === "ping") return send(res, 200, { ok: true, pong: true }), true;
    let payload: unknown = {};
    try {
      payload = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    } catch {
      throw new HttpError(400, "Expected a JSON body");
    }
    const wanted = readWebhook(req.headers, payload);
    if (!wanted) return send(res, 200, { ignored: "This event doesn't start a run" }), true;
    const fired = await automations.fire(trigger.id, { via: "webhook", ...wanted }).catch((err: Error) => {
      throw err instanceof HttpError ? err : new HttpError(400, err.message);
    });
    if (fired.skipped) return send(res, 409, { skipped: fired.skipped }), true;
    send(res, 202, { run: fired.run!.id });
    return true;
  }
  if (parts[0] === "r" && req.method === "GET") {
    const token = parts[1] ?? "";
    if (!remote.enabled || !tokenMatches(token, remote.token)) throw new HttpError(404, "Not found");
    const base = `/r/${token}`;
    if (via === "lan" && phoneControl()) {
      // Full control: the link signs this phone in and opens the app (on the run it linked to).
      const run = url.pathname.slice(base.length).match(/^\/run\/([\w-]+)$/)?.[1];
      res.writeHead(302, { location: run ? `/#/run/${run}` : "/", "set-cookie": phoneCookie(), "cache-control": "no-store", "referrer-policy": "no-referrer" });
      res.end();
      return true;
    }
    const html = renderRemote(manager, base, url.pathname.slice(base.length));
    if (!html) throw new HttpError(404, "Not found");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" });
    res.end(html);
    return true;
  }
  return false;
}

function remoteInfo() {
  return {
    enabled: remote.enabled,
    lan: remote.lan,
    control: remote.control,
    path: `/r/${remote.token}`,
    local: `http://localhost:${PORT}/r/${remote.token}`,
    lanUrls: remote.lan ? lanAddresses().map((ip) => `http://${ip}:${REMOTE_PORT}/r/${remote.token}`) : [],
  };
}

/**
 * A second listener on your network for your phone and webhooks: the phone view, or with phone
 * control the whole app for a phone signed in with the phone link. `signOut` drops the phones'
 * open connections (their live event streams would otherwise keep going).
 */
let lanServer: ReturnType<typeof createServer> | undefined;
function syncLanServer(signOut = false) {
  if (remote.enabled && remote.lan && !lanServer) {
    lanServer = createServer(listener("lan")).listen(REMOTE_PORT, "0.0.0.0");
    lanServer.on("error", (err) => console.error(`Phone view on port ${REMOTE_PORT}: ${err.message}`));
  } else if ((!remote.enabled || !remote.lan) && lanServer) {
    lanServer.close();
    lanServer.closeAllConnections();
    lanServer = undefined;
  } else if (signOut) {
    lanServer?.closeAllConnections();
  }
}

function openStream(req: IncomingMessage, res: ServerResponse): (event: unknown) => void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => clearInterval(ping));
  return (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function streamEvents(req: IncomingMessage, res: ServerResponse, runId: string) {
  const write = openStream(req, res);
  // Subscribe before replaying so nothing emitted in between is lost; the client de-dupes by seq.
  const unsubscribe = manager.subscribe(runId, write);
  req.on("close", unsubscribe);
  for (const event of await manager.events(runId)) write(event);
}

/** Every run's status changes, for the sidebar and notifications. */
function streamAllRuns(req: IncomingMessage, res: ServerResponse) {
  const write = openStream(req, res);
  const unsubscribe = manager.subscribeAll((run) => write({ type: "run", run }));
  req.on("close", unsubscribe);
}

/** Which listener a request came in on: this machine's, or the one on your network. */
type Via = "local" | "lan";

async function handle(req: IncomingMessage, res: ServerResponse, via: Via) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  if (await handlePublic(req, res, url, parts, via)) return;
  if (via === "lan") {
    checkLanOrigin(req);
    if (req.method === "GET" && url.pathname === "/") {
      const ok = phoneSignedIn(req);
      res.writeHead(ok ? 200 : 401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" });
      return res.end(ok ? await readFile(indexHtml) : PHONE_LOCKED_PAGE);
    }
    // Without phone control, the network listener serves only the phone view and webhooks.
    if (!phoneControl()) throw new HttpError(404, "Not found");
  } else {
    checkOrigin(req);
  }

  if (req.method === "GET" && url.pathname === "/") {
    const given = url.searchParams.get("token");
    if (given) {
      if (!tokenMatches(given, auth.token)) throw new HttpError(403, "That link is from an earlier code-flow session; use the one printed when it last started");
      // Drop the token from the address bar (and history); the cookie carries it from here.
      res.writeHead(302, { location: "/", "set-cookie": sessionCookie(), "cache-control": "no-store", "referrer-policy": "no-referrer" });
      return res.end();
    }
    const claim = !signedIn(req) && auth.claimable;
    if (!signedIn(req) && !claim) {
      res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(LOCKED_PAGE);
    }
    if (claim) auth.claimable = false;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...(claim ? { "set-cookie": sessionCookie() } : {}) });
    res.end(await readFile(indexHtml));
    return;
  }

  if (parts[0] !== "api") throw new HttpError(404, "Not found");
  if (via === "lan" ? !phoneSignedIn(req) : !signedIn(req)) {
    throw Object.assign(new HttpError(401, via === "lan" ? "Not signed in: scan the phone QR code again" : "Not signed in: reload code-flow, or open it from the link printed at startup"), { signIn: true });
  }

  if (req.method === "GET" && parts[1] === "agents") return send(res, 200, await agentAvailability());
  if (req.method === "GET" && parts[1] === "events") return streamAllRuns(req, res);
  if (req.method === "GET" && parts[1] === "patterns") return send(res, 200, patterns.map(describePattern));
  if (req.method === "GET" && parts[1] === "fs") {
    const listing = await listDirectories(url.searchParams.get("path") ?? undefined, url.searchParams.get("hidden") === "1")
      .catch((err: NodeJS.ErrnoException) => {
        const status = err.code === "ENOENT" ? 404 : err.code === "EACCES" || err.code === "EPERM" ? 403 : 400;
        throw new HttpError(status, err.code === "ENOENT" ? "Folder not found" : err.message);
      });
    return send(res, 200, listing);
  }
  if (req.method === "GET" && parts[1] === "branches") {
    const repo = await requestedRepo(url);
    return send(res, 200, { repo, worktreeRoot: worktreeRoot(repo), ...(await listBranches(repo)) });
  }
  if (req.method === "GET" && parts[1] === "tree") {
    const repo = await requestedRepo(url);
    const listing = await listTree(repo, url.searchParams.get("path") ?? "").catch((err: NodeJS.ErrnoException) => {
      throw new HttpError(err.code === "ENOENT" ? 404 : 400, err.code === "ENOENT" ? "Folder not found" : err.message);
    });
    return send(res, 200, listing);
  }
  if (req.method === "GET" && parts[1] === "doctor") return send(res, 200, await doctor(manager.quota));
  if (req.method === "GET" && parts[1] === "health") {
    return send(res, 200, { busy: manager.busy, writes: writeHealth, runs: manager.list().filter((r) => r.status === "running").length });
  }
  if (req.method === "GET" && parts[1] === "stats") {
    const since = Number(url.searchParams.get("since")) || undefined;
    const repo = url.searchParams.get("repo") ? await requestedRepo(url) : undefined;
    return send(res, 200, computeStats(runsIn(url.searchParams.get("project")), { repo, since }));
  }
  if (req.method === "POST" && parts[1] === "compare") return send(res, 201, await startComparison(await readJson(req)));
  if (req.method === "GET" && parts[1] === "disk") {
    return send(res, 200, await diskUsage(runsIn(url.searchParams.get("project")), url.searchParams.get("repo") ? await requestedRepo(url) : undefined));
  }
  if (req.method === "POST" && parts[1] === "cleanup") {
    const body = await readJson(req);
    return send(res, 200, await cleanUp(runsIn(body.project), Math.max(0, Number(body.olderThanDays ?? 7)), typeof body.repo === "string" ? body.repo : undefined));
  }
  if (parts[1] === "projects") {
    const id = parts[2];
    if (!id && req.method === "GET") return send(res, 200, projects.list());
    if (!id && req.method === "POST") {
      const body = await readJson(req);
      return send(res, 201, await attempt(() => projects.create({ name: body.name, repos: Array.isArray(body.repos) ? body.repos : [] })));
    }
    if (id && !projects.get(id)) throw new HttpError(404, "Project not found");
    if (id && req.method === "POST") {
      const body = await readJson(req);
      return send(res, 200, await attempt(() => manager.updateProject(id, { name: body.name, repos: Array.isArray(body.repos) ? body.repos : undefined })));
    }
    if (id && req.method === "DELETE") {
      await manager.removeProject(id);
      return send(res, 200, { deleted: true });
    }
  }
  if (req.method === "GET" && parts[1] === "templates") return send(res, 200, templates);
  if (parts[1] === "remote") {
    if (req.method === "POST") {
      const body = await readJson(req);
      const before = { ...remote };
      if (typeof body.enabled === "boolean") remote.enabled = body.enabled;
      if (typeof body.lan === "boolean") remote.lan = body.lan;
      if (typeof body.control === "boolean") remote.control = body.control;
      if (body.rotate) remote.token = newToken();
      await saveRemote(remote);
      const signOut = remote.token !== before.token || (phoneControl(before) && !phoneControl());
      // After replying (or a dropped request): the phone may be the one turning itself off.
      res.once("close", () => syncLanServer(signOut));
    }
    return send(res, 200, remoteInfo());
  }
  if (parts[1] === "automations") {
    const id = parts[2];
    if (!id && req.method === "GET") return send(res, 200, automations.list().map(describeAutomation));
    if (!id && req.method === "POST") {
      const body = await readJson(req);
      const name = String(body.name ?? "").trim().slice(0, 80);
      if (!name) throw new HttpError(400, "Name the automation");
      const run = automationRun(body.run ?? {});
      await buildStartInput(run); // same checks as starting it now
      const schedule = await attempt(async () => validateSchedule(body.schedule));
      if (!schedule && !body.webhook) throw new HttpError(400, "Give it a schedule, a webhook, or both");
      const trigger = await automations.create({ name, enabled: body.enabled !== false, run, schedule, webhook: !!body.webhook, isolate: !!body.isolate, image: typeof body.image === "string" ? body.image.trim() || undefined : undefined });
      return send(res, 201, describeAutomation(trigger));
    }
    if (id && !automations.get(id)) throw new HttpError(404, "Automation not found");
    if (id && req.method === "DELETE") {
      await automations.remove(id);
      return send(res, 200, { deleted: true });
    }
    if (id && req.method === "POST" && parts[3] === "run") {
      const fired = await attempt(() => automations.fire(id, { via: "manual" }));
      if (fired.skipped) throw new HttpError(409, `Skipped: ${fired.skipped}`);
      return send(res, 201, { id: fired.run?.id ?? fired.runs?.[0]?.id, ids: fired.runs?.map((r) => r.id) });
    }
    if (id && req.method === "POST" && !parts[3]) {
      const body = await readJson(req);
      const patch: Parameters<typeof automations.update>[1] = {};
      if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 80);
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (typeof body.webhook === "boolean") patch.webhook = body.webhook;
      if (typeof body.isolate === "boolean") patch.isolate = body.isolate;
      if (typeof body.image === "string") patch.image = body.image.trim() || undefined;
      if ("schedule" in body) patch.schedule = await attempt(async () => validateSchedule(body.schedule));
      if (body.rotateToken) patch.rotateToken = true;
      return send(res, 200, describeAutomation(await automations.update(id, patch)));
    }
  }
  if (req.method === "GET" && parts[1] === "github" && parts[2] === "sweep") {
    const repo = await requestedRepo(url);
    const kind = url.searchParams.get("kind") as SweepKind;
    if (!SWEEP_KINDS.includes(kind)) throw new HttpError(400, "Unknown kind of sweep");
    return send(res, 200, await attempt(() => listSweep(repo, kind, manager.list())));
  }
  if (req.method === "POST" && parts[1] === "sweeps") return send(res, 201, await startSweep(await readJson(req)));
  if (req.method === "GET" && parts[1] === "github" && (parts[2] === "issues" || parts[2] === "prs")) {
    const repo = await requestedRepo(url);
    return send(res, 200, await attempt<unknown[]>(() => (parts[2] === "issues" ? listIssues(repo) : listPullRequests(repo))));
  }
  if (req.method === "GET" && parts[1] === "repo-config") {
    const repo = await requestedRepo(url);
    return send(res, 200, await readRepoConfig(repo));
  }
  if (req.method === "GET" && parts[1] === "check") {
    const repo = await requestedRepo(url);
    return send(res, 200, (await detectCheckCommand(repo)) ?? { command: null });
  }
  if (req.method === "GET" && parts[1] === "search") {
    const repo = await requestedRepo(url);
    return send(res, 200, await searchFiles(repo, url.searchParams.get("q") ?? ""));
  }
  if (req.method === "GET" && parts[1] === "models") {
    const agents = await agentAvailability();
    const entries = await Promise.all(
      agents.map(async (a) => {
        if (!a.available) return [a.id, { error: "not installed" }] as const;
        return [a.id, await agentCatalog(a.id).catch((err: Error) => ({ error: err.message }))] as const;
      }),
    );
    return send(res, 200, Object.fromEntries(entries));
  }

  if (parts[1] === "runs") {
    const runId = parts[2];
    if (!runId) {
      if (req.method === "GET") return send(res, 200, manager.list());
      if (req.method === "POST") {
        const body = await readJson(req);
        const run = await startFromBody(body);
        // The composer starts from this team next time you're in the project. A reply reuses the old run's team, so it isn't a choice.
        if (run.project && !body.parentRunId) {
          void projects.remember(run.project, { pattern: run.pattern, roles: requestedRoles(findPattern(run.pattern)!, body.roles), roleSettings: run.roleSettings, agentSettings: validateAgentSettings(body.agentSettings) });
        }
        return send(res, 201, { id: run.id, project: run.project });
      }
    }

    const run = runId ? manager.get(runId) : undefined;
    if (!run) throw new HttpError(404, "Run not found");
    if (req.method === "GET" && parts.length === 3) return send(res, 200, run);
    if (req.method === "GET" && parts[3] === "events") return streamEvents(req, res, run.id);
    if (req.method === "POST" && parts[3] === "cancel") return send(res, 200, { cancelled: manager.cancel(run.id) });
    if (req.method === "POST" && parts[3] === "resume") {
      await manager.resume(run.id).catch((err: Error) => {
        throw new HttpError(400, err.message);
      });
      return send(res, 200, { resumed: true });
    }
    if (req.method === "POST" && parts[3] === "project") {
      const body = await readJson(req);
      if (typeof body.project !== "string" || !projects.get(body.project)) throw new HttpError(400, "Pick a project");
      return send(res, 200, await attempt(() => manager.setProject(run.id, body.project)));
    }
    if (req.method === "POST" && parts[3] === "seen") {
      manager.setSeen(run.id, true);
      return send(res, 200, { seen: true });
    }
    if (req.method === "POST" && parts[3] === "archive") {
      const body = await readJson(req);
      if (body.archived === false) {
        await attempt(async () => manager.setArchived(run.id, false));
        return send(res, 200, { archived: false });
      }
      const result = await attempt(() => manager.archive(run.id, { cleanup: body.cleanup !== false, deleteBranches: !!body.deleteBranches }));
      return send(res, 200, { archived: true, ...result });
    }
    if (req.method === "GET" && parts[3] === "diff") {
      return send(res, 200, await attempt(() => manager.diff(run.id, url.searchParams.get("branch") ?? "")));
    }
    if (req.method === "POST" && parts[3] === "followups") {
      const body = await readJson(req);
      if (!isAgentId(body.agent)) throw new HttpError(400, "Pick an agent");
      await attempt(() =>
        manager.followUp(run.id, {
          kind: body.kind === "resolve-conflicts" ? "resolve-conflicts" : body.kind === "reply" ? "reply" : "comments",
          worktree: String(body.worktree ?? ""),
          agent: body.agent,
          message: typeof body.message === "string" ? body.message : undefined,
          mergeFrom: typeof body.mergeFrom === "string" ? body.mergeFrom : undefined,
        }),
      );
      return send(res, 200, { ok: true });
    }
    // /api/runs/:id/worktrees/:name/(open|serve)
    if (parts[3] === "worktrees" && parts[4]) {
      const wt = run.worktrees.find((w) => w.name === parts[4]);
      if (!wt) throw new HttpError(404, "Unknown worktree");
      const key = `${run.id}/${wt.name}`;
      if (req.method === "POST" && parts[5] === "open") {
        const body = await readJson(req);
        const target = body.target === "editor" || body.target === "finder" ? body.target : "terminal";
        return send(res, 200, { openedWith: await attempt(() => openFolder(wt.path, target)) });
      }
      if (parts[5] === "serve") {
        if (req.method === "GET") return send(res, 200, manager.devServers.get(key) ?? null);
        if (req.method === "DELETE") return send(res, 200, { stopped: manager.devServers.stop(key) });
        if (req.method === "POST") {
          const body = await readJson(req);
          const command = (typeof body.command === "string" && body.command.trim()) || run.app?.command;
          if (!command) throw new HttpError(400, 'Say how to run the app (e.g. "npm run dev"), or add "run" to .codeflow/config.json');
          if (/[\r\n]/.test(command)) throw new HttpError(400, "The command must be a single line");
          manager.noteActivity(); // the app is the repo's code running on this machine
          return send(res, 200, await manager.devServers.start(key, wt.path, command, run.app?.port));
        }
      }
    }
    if (req.method === "POST" && parts[3] === "notes") {
      const body = await readJson(req);
      const note = await attempt(async () => manager.addNote(run.id, String(body.text ?? ""), isAgentId(body.agent) ? body.agent : undefined));
      return send(res, 200, note);
    }
    if (req.method === "POST" && parts[3] === "answer") {
      const body = await readJson(req);
      const decision = body.decision;
      if (decision !== "approve" && decision !== "revise" && decision !== "reject") throw new HttpError(400, "Unknown decision");
      await attempt(async () => manager.answer(run.id, { decision, note: typeof body.note === "string" ? body.note : undefined }));
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && parts[3] === "merge") {
      const body = await readJson(req);
      const outcome = await attempt(() =>
        manager.merge(run.id, { branch: String(body.branch ?? ""), into: String(body.into ?? ""), archiveAfter: !!body.archiveAfter }),
      );
      return send(res, 200, outcome);
    }
    if (req.method === "GET" && parts[3] === "pr-targets") {
      // Branches on GitHub a pull request can go into, and the one it would go into by default.
      const targets = await attempt(async () => {
        const { branches } = await remoteBranches(run.repo);
        return { branches, initial: await manager.pullRequestTarget(run.id) };
      });
      return send(res, 200, targets);
    }
    if (req.method === "POST" && parts[3] === "pr") {
      const body = await readJson(req);
      const prUrl = await attempt(() => manager.pullRequest(run.id, { branch: String(body.branch ?? ""), into: String(body.into ?? "") }));
      return send(res, 200, { url: prUrl });
    }
    if (req.method === "POST" && parts[3] === "triage") {
      const body = await readJson(req);
      if (!["approve", "revise", "reject"].includes(body.decision)) throw new HttpError(400, "Unknown decision");
      await attempt(() => manager.triage(run.id, { decision: body.decision, note: typeof body.note === "string" ? body.note : undefined, openPr: !!body.openPr, pushPr: !!body.pushPr }));
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && parts[3] === "push-pr") {
      const body = await readJson(req);
      return send(res, 200, await attempt(() => manager.pushToPr(run.id, { branch: String(body.branch ?? "") })));
    }
    if (req.method === "POST" && parts[3] === "post-review") {
      return send(res, 200, { url: await attempt(() => manager.postReview(run.id)) });
    }
    if (req.method === "POST" && parts[3] === "watch") {
      const body = await readJson(req);
      const branch = String(body.branch ?? "");
      if (body.stop) {
        await attempt(async () => manager.unwatchPr(run.id, branch));
        return send(res, 200, { watching: false });
      }
      if (!isAgentId(body.agent)) throw new HttpError(400, "Pick the agent that fixes problems");
      const allow = Array.isArray(body.allow) ? body.allow.filter((a: unknown): a is string => typeof a === "string").slice(0, 20) : [];
      const watch = await attempt(async () => manager.watchPr(run.id, { branch, agent: body.agent, maxFixes: Number(body.maxFixes) || undefined, allow }));
      void watcher.poll();
      return send(res, 200, watch);
    }
  }

  throw new HttpError(404, "Not found");
}

await manager.load();
await projects.load(manager.list());
await automations.load();
remote = await loadRemote();
watcher.start();
automations.start(Number(process.env.CODEFLOW_SCHEDULER_TICK_MS) || 30_000);
syncLanServer();

function listener(via: Via) {
  return (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res, via).catch((err: Error & { confirm?: string; signIn?: boolean }) => {
      if (res.headersSent) return res.end();
      send(res, err instanceof HttpError ? err.status : 500, { error: err.message, confirm: err.confirm, signIn: err.signIn });
    });
  };
}

const server = createServer(listener("local")).listen(PORT, HOST, async () => {
  const agents = await agentAvailability();
  const runs = manager.list();
  console.log(`code-flow running at http://localhost:${PORT}  (${runs.length} runs loaded from ${CODEFLOW_HOME})`);
  console.log(`  Open http://localhost:${PORT}/?token=${auth.token}  (the first browser to open code-flow signs in without it)`);
  for (const a of agents) console.log(`  ${a.available ? "✓" : "✗"} ${a.displayName} (${a.binary})`);
  const interrupted = runs.filter((r) => r.status === "interrupted").length;
  if (interrupted) console.log(`  ${interrupted} interrupted run(s) can be resumed from the UI`);
});

// A previous instance may still be shutting down (e.g. a dev restart): wait for the port
// instead of crashing.
let listenAttempts = 0;
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE" && ++listenAttempts <= 40) {
    if (listenAttempts === 1) console.log(`Port ${PORT} is busy; waiting for it to be released…`);
    setTimeout(() => server.listen(PORT, HOST), 500);
    return;
  }
  console.error(err.code === "EADDRINUSE" ? `Port ${PORT} is still in use. Is code-flow already running?` : err);
  process.exit(1);
});

/**
 * Compare setups: start the same task with several patterns or teams at once (optionally a few
 * times each), as one group. Insights shows them side by side: did it pass, how long, how many
 * steps and tokens, did it touch the tests.
 */
async function startComparison(body: Record<string, any>) {
  const variants = Array.isArray(body.variants) ? body.variants.slice(0, 6) : [];
  if (variants.length < 2) throw new HttpError(400, "Add at least two setups to compare");
  const repeat = Math.min(3, Math.max(1, Math.round(Number(body.repeat) || 1)));
  if (variants.length * repeat > 9) throw new HttpError(400, "That's more than 9 runs; compare fewer setups or repeat less");
  const base = body.run && typeof body.run === "object" ? body.run : {};
  // Check every setup before starting any, so a typo doesn't leave half a comparison running.
  const inputs = await Promise.all(
    variants.map(async (v: Record<string, any>, i: number) => {
      const label = String(v.label ?? "").trim().slice(0, 40) || `Setup ${i + 1}`;
      return {
        label,
        input: await buildStartInput({ ...base, pattern: v.pattern ?? base.pattern, roles: v.roles ?? base.roles, options: v.options ?? base.options, roleSettings: v.roleSettings ?? base.roleSettings }),
      };
    }),
  );
  const group = { id: `g${Date.now().toString(36)}${randomBytes(2).toString("hex")}` };
  const started: string[] = [];
  for (let n = 1; n <= repeat; n++) {
    for (const { label, input } of inputs) {
      const run = await manager.start({ ...input, group: { id: group.id, label: repeat > 1 ? `${label} #${n}` : label } }).catch((err: Error) => {
        throw new HttpError(400, `${label}: ${err.message}`);
      });
      started.push(run.id);
    }
  }
  return { group: group.id, runs: started };
}

/** Runs in a project ("none": in no project), or all runs. */
function runsIn(project: unknown) {
  const all = manager.list();
  if (typeof project !== "string" || !project) return all;
  const list = projects.list();
  return all.filter((r) => (projectOf(r, list) ?? "none") === project);
}

/** Disk space taken by each run's worktrees (every worktree holds its own node_modules…). */
async function diskUsage(all: ReturnType<typeof manager.list>, repo?: string) {
  const runs = all.filter((r) => !repo || r.repo === repo);
  const sizes = await folderSizes(runs.map((r) => r.worktreeDir));
  const list = runs
    .filter((r) => sizes[r.worktreeDir] !== undefined)
    .map((r) => ({ id: r.id, task: r.task.split("\n")[0]!.slice(0, 100), repo: r.repo, status: r.status, archived: r.archived, endedAt: r.endedAt, bytes: sizes[r.worktreeDir]! }))
    .sort((a, b) => b.bytes - a.bytes);
  return { total: list.reduce((n, r) => n + r.bytes, 0), runs: list };
}

/**
 * Remove the worktrees (not the branches) of runs that finished more than `days` ago and need
 * nothing from you: seen, not waiting in the inbox, not watching a PR. Committed work stays on
 * its branch and comes back if you resume or follow up.
 */
async function cleanUp(all: ReturnType<typeof manager.list>, days: number, repo?: string) {
  const cutoff = Date.now() - days * 86_400_000;
  const done: string[] = [];
  let removed = 0;
  for (const r of all) {
    if (repo && r.repo !== repo) continue;
    if (r.status === "running" || !r.endedAt || r.endedAt > cutoff || !r.seen) continue;
    if (r.triage?.state === "pending" || Object.values(r.watches).some((w) => ["watching", "fixing", "green"].includes(w.state))) continue;
    const result = await removeWorktrees(r.repo, r.worktrees, false).catch(() => undefined);
    if (!result?.removed.length) continue;
    removed += result.removed.length;
    done.push(r.id);
    if (!r.archived) manager.setArchived(r.id, true);
    manager.log(r.id, `Cleaned up: removed ${result.removed.length} worktree(s); branches kept`);
  }
  return { runs: done.length, worktrees: removed };
}

// Stop cleanly: running agents are stopped and their runs marked "interrupted" (resumable).
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (stopping) process.exit(1); // second Ctrl-C: don't wait
    stopping = true;
    console.log("\nStopping code-flow: interrupting running runs so they can be resumed…");
    server.close();
    lanServer?.close();
    watcher.stop();
    automations.stop();
    await manager.shutdown();
    process.exit(0);
  });
}
