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
import { listTree, readRepoFile, searchFiles } from "./repo-tree.js";
import { checkGit, doctor } from "./doctor.js";
import { readRepoConfig } from "./repo-config.js";
import { openFolder } from "./serve.js";
import { Shells, type ShellEvent } from "./shell.js";
import { Notes } from "./notes.js";
import { CODEFLOW_HOME, envNumber, PORT } from "./config.js";
import { RunManager, UntrustedSourceError, type LoopSettings, type Pattern } from "./engine.js";
import { detectCheckCommand } from "./checks.js";
import { findPattern, patterns } from "./patterns/index.js";
import { listDirectories } from "./fs.js";
import { listBranches, repoRoot, worktreeRoot } from "./git.js";
import { stat } from "node:fs/promises";
import { folderSizes, remoteBranches, removeWorktrees } from "./ship.js";
import { computeStats, rankAgents } from "./stats.js";
import { acquireLock, writeHealth } from "./store.js";
import { reapOrphanGroups } from "./adapters/process.js";
import { logError, logInfo, logWarn } from "./log.js";
import { listIssues, listPullRequests, type SourceInput } from "./github.js";
import { listSweep, runSweep, sourceKeys, type SweepKind } from "./sweeps.js";
import { resolveAuto } from "./routing.js";
import { templates } from "./templates.js";
import { PrWatcher } from "./watch.js";
import { Automations, describeSchedule, readWebhook, validateSchedule } from "./automation.js";
import { changeRemote, isOwnAddress, lanAddresses, loadRemote, renderRemote, saveRemote, tokenMatches, type RemoteSettings } from "./remote.js";
import { projectOf, Projects } from "./projects.js";
import type { Run, RunEvent, RunSummary, StartRunInput } from "./engine.js";

// One server per CODEFLOW_HOME (waits for one that is still shutting down).
const releaseLock = await acquireLock().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
process.once("exit", releaseLock);

// A stray rejection or throw must not take every live run down with it: log it and keep
// serving. A burst of uncaught exceptions means state is likely broken, so then stop cleanly
// (runs are interrupted, resumable) rather than limp on.
const recentCrashes: number[] = [];
process.on("unhandledRejection", (reason) => logError("Unhandled promise rejection", reason));
process.on("uncaughtException", (err) => {
  logError("Uncaught exception", err);
  const now = Date.now();
  recentCrashes.push(now);
  while (recentCrashes[0]! < now - 60_000) recentCrashes.shift();
  if (recentCrashes.length >= 10) void stop("too many uncaught exceptions in a minute", 1);
});

// Agents and checks a previous code-flow left running (it crashed, or its terminal closed)
// would keep editing worktrees: stop them before any run is resumed.
const reaped = await reapOrphanGroups();
if (reaped) logInfo(`Stopped ${reaped} process group(s) a previous code-flow left running`);

const projects = new Projects();
const manager = new RunManager(findPattern, projects);
/** The side panel's terminals and notes. */
const shells = new Shells();
const notes = new Notes();
const watcher = new PrWatcher(manager);
const automations = new Automations(manager, (body, extra) => startFromBody(body, extra), (repo, kind) => listSweep(repo, kind, manager.list()));
let remote: RemoteSettings;
const REMOTE_PORT = envNumber("CODEFLOW_REMOTE_PORT", PORT + 1, { min: 1, max: 65_535 });
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

/**
 * Only a browser on this machine may claim the session. The Host header alone doesn't say so:
 * a tunnel (ngrok, cloudflared) forwarding to this port can rewrite it to localhost, and then
 * the first stranger through the tunnel would sign in. Its connection still comes from the
 * tunnel's process on this machine, so the forwarding headers it adds are what give it away.
 */
function mayClaim(req: IncomingMessage): boolean {
  const forwarded = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "cf-connecting-ip", "true-client-ip"].some((h) => req.headers[h] !== undefined);
  const address = (req.socket.remoteAddress ?? "").replace(/^::ffff:/i, "");
  return auth.claimable && !forwarded && (address === "::1" || address.startsWith("127."));
}

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
 * `/r/<controlToken>` on the network listener sets this cookie and opens the app. That secret is
 * full control's own (the read-only link never signs a phone in) and is saved in remote.json,
 * so the phone stays signed in across restarts for up to 30 days, until you make a new link or
 * turn phone control, the Wi-Fi listener or the phone link off. The name carries the port
 * because cookies ignore ports, and a second code-flow on this machine has a link of its own.
 */
const PHONE_COOKIE = `codeflow_phone_${REMOTE_PORT}`;
const PHONE_COOKIE_DAYS = 30;
const phoneControl = (s: RemoteSettings = remote) => s.enabled && s.lan && s.control;

function phoneCookie(): string {
  return `${PHONE_COOKIE}=${remote.controlToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${PHONE_COOKIE_DAYS * 86_400}`;
}

function phoneSignedIn(req: IncomingMessage): boolean {
  const cookie = readCookie(req, PHONE_COOKIE);
  return phoneControl() && !!cookie && tokenMatches(cookie, remote.controlToken);
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

/**
 * What the full-control link answers with: it sets the phone's cookie, then moves on to the app.
 * Not a redirect: a QR scanner hands the link to the browser from another app, so the browser
 * counts it as a cross-site navigation and leaves the SameSite=Strict cookie off a redirect that
 * follows — the phone would land on "Scan the QR code again". This page moving on by itself is
 * same-site, so the cookie goes along; `replace` keeps the link out of the phone's history.
 */
const signingInPage = (target: string) =>
  lockedPage("signing in", `<h1>Signing in…</h1><p><a href="${target}">Open code-flow</a></p><script>location.replace(${JSON.stringify(target)})</script>`);

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
  if (saved) {
    const started = new Set(outcome.started.map((s) => s.key));
    await automations.markHandled(saved.id, items.filter((i) => started.has(i.key)).flatMap((i) => sourceKeys(i.source)));
  }
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
    trust: ["safe", "standard", "trusted", "full"].includes(body.trust) ? body.trust : undefined,
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
    // Answered before the run starts: GitHub gives up on a delivery after 10 seconds. Whether it
    // started, waits for a running run, or why not, shows on the automation.
    const delivery = typeof req.headers["x-github-delivery"] === "string" ? req.headers["x-github-delivery"].slice(0, 100) : undefined;
    const accepted = automations.accept(trigger.id, wanted, delivery);
    send(res, "ignored" in accepted ? 200 : 202, "ignored" in accepted ? accepted : { accepted: true, automation: trigger.id });
    return true;
  }
  if (parts[0] === "r" && req.method === "GET") {
    const token = parts[1] ?? "";
    if (!remote.enabled) throw new HttpError(404, "Not found");
    const base = `/r/${token}`;
    if (via === "lan" && phoneControl() && tokenMatches(token, remote.controlToken)) {
      // Full control: the link signs this phone in and opens the app (on the run it linked to).
      const run = url.pathname.slice(base.length).match(/^\/run\/([\w-]+)$/)?.[1];
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": phoneCookie(), "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" });
      res.end(signingInPage(run ? `/#/run/${run}` : "/"));
      return true;
    }
    // The read-only link only ever shows the read-only view, whatever is turned on.
    if (!tokenMatches(token, remote.token)) throw new HttpError(404, "Not found");
    const html = renderRemote(manager, base, url.pathname.slice(base.length));
    if (!html) throw new HttpError(404, "Not found");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" });
    res.end(html);
    return true;
  }
  return false;
}

function remoteInfo() {
  // What the QR code opens: with full control the sign-in link, otherwise the read-only view.
  const phonePath = `/r/${phoneControl() ? remote.controlToken : remote.token}`;
  return {
    enabled: remote.enabled,
    lan: remote.lan,
    control: remote.control,
    path: `/r/${remote.token}`,
    phonePath,
    local: `http://localhost:${PORT}/r/${remote.token}`,
    lanUrls: remote.lan && lanServer && !lanError ? lanAddresses().map((ip) => `http://${ip}:${REMOTE_PORT}${phonePath}`) : [],
    lanError: remote.enabled && remote.lan ? lanError : undefined,
  };
}

/**
 * A second listener on your network for your phone and webhooks: the phone view, or with phone
 * control the whole app for a phone signed in with the phone link. `signOut` drops the phones'
 * open connections (their live event streams would otherwise keep going).
 *
 * It refuses connections from this machine itself. Programs here (the agents code-flow runs
 * among them) can read ~/.codeflow, phone secrets included; through this listener they could
 * sign in with full control and run anything outside their sandboxes. Binding only to the Wi-Fi
 * addresses wouldn't stop that — a program here can connect to those as well, and its
 * connection then comes from that same address — so each connection's source is checked
 * against all of this machine's addresses instead. CODEFLOW_LAN_ALLOW_LOCAL=1 lifts this for
 * tests that play the phone on the same machine.
 */
let lanServer: ReturnType<typeof createServer> | undefined;
/** Why the network listener isn't listening (e.g. its port is taken), shown instead of a QR code. */
let lanError: string | undefined;
const LAN_ALLOW_LOCAL = process.env.CODEFLOW_LAN_ALLOW_LOCAL === "1";

/** Start, stop or sign out the network listener to match the settings; resolves once it's listening (or failed to). */
function syncLanServer(signOut = false): Promise<void> {
  if (remote.enabled && remote.lan && !lanServer) {
    lanError = undefined;
    const server = createServer(listener("lan"));
    server.on("connection", (socket) => {
      if (!LAN_ALLOW_LOCAL && isOwnAddress(socket.remoteAddress)) socket.destroy();
    });
    const ready = new Promise<void>((resolve) => {
      server.once("listening", resolve);
      server.on("error", (err: NodeJS.ErrnoException) => {
        lanError =
          err.code === "EADDRINUSE"
            ? `Port ${REMOTE_PORT} is already in use by another program, so your phone can't reach code-flow. Start code-flow with CODEFLOW_REMOTE_PORT set to a free port.`
            : `code-flow couldn't listen on your network (port ${REMOTE_PORT}): ${err.message}`;
        logError(lanError, err);
        if (lanServer === server) lanServer = undefined;
        server.close();
        resolve();
      });
    });
    server.listen(REMOTE_PORT, "0.0.0.0");
    lanServer = server;
    return ready;
  } else if ((!remote.enabled || !remote.lan) && (lanServer || lanError)) {
    lanServer?.close();
    lanServer?.closeAllConnections();
    lanServer = undefined;
    lanError = undefined;
  } else if (signOut) {
    lanServer?.closeAllConnections();
  }
  return Promise.resolve();
}

/**
 * A random id per server start. Event numbers are only comparable within one start (a crash can
 * lose the last few, and they're numbered again), so a client that sees it change starts over.
 */
const EPOCH = randomBytes(6).toString("hex");
/** A client that stops reading (a phone gone to sleep) is dropped after this, rather than buffered for. */
const STALL_MS = envNumber("CODEFLOW_SSE_STALL_MS", 30_000, { min: 100 });

/**
 * An event stream. Each event carries `id: <epoch>:<seq>`, which the browser sends back as
 * Last-Event-ID when it reconnects, so only what it missed is sent again.
 */
function openStream(res: ServerResponse): { send(event: unknown, seq?: number): void } {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let stalled: ReturnType<typeof setTimeout> | undefined;
  const write = (chunk: string) => {
    if (res.destroyed || res.writableEnded) return;
    if (res.write(chunk) || stalled) return;
    // The client's buffer is full: wait for it to drain, but not forever.
    stalled = setTimeout(() => res.destroy(), STALL_MS);
    res.once("drain", () => {
      clearTimeout(stalled);
      stalled = undefined;
    });
  };
  const ping = setInterval(() => write(": ping\n\n"), 15_000);
  res.on("close", () => {
    clearInterval(ping);
    clearTimeout(stalled);
  });
  return { send: (event, seq) => write(`${seq === undefined ? "" : `id: ${EPOCH}:${seq}\n`}data: ${JSON.stringify(event)}\n\n`) };
}

/** The last event a reconnecting client got (its Last-Event-ID), if it's from this server start. */
function lastEventSeq(req: IncomingMessage): number | undefined {
  const [epoch, seq] = String(req.headers["last-event-id"] ?? "").split(":");
  const n = Number(seq);
  return epoch === EPOCH && seq !== "" && Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * A run's events: its history, then live ones. Live events that arrive while the history is
 * still being read wait for it, so the client never gets an older snapshot after a newer one.
 */
async function streamEvents(req: IncomingMessage, res: ServerResponse, runId: string) {
  const stream = openStream(res);
  const after = lastEventSeq(req);
  // Which server start this is: the client keeps what it has only when it's the one it knew.
  stream.send({ type: "hello", epoch: EPOCH, resumed: after !== undefined });
  let last = after ?? 0;
  const deliver = (e: RunEvent) => {
    if (e.seq <= last) return;
    last = e.seq;
    stream.send(e, e.seq);
  };
  let waiting: RunEvent[] | undefined = [];
  const unsubscribe = manager.subscribe(runId, (e) => (waiting ? waiting.push(e) : deliver(e)));
  res.on("close", unsubscribe);
  try {
    for (const event of await manager.events(runId)) deliver(event);
  } finally {
    const live = waiting.sort((a, b) => a.seq - b.seq);
    waiting = undefined;
    for (const event of live) deliver(event);
  }
}

/**
 * Every run snapshot as it changes, numbered, with the latest few hundred kept so a client that
 * reconnects gets only what it missed. Subscribed before runs load, so none is missed.
 */
const runFeed = { seq: 0, recent: [] as { seq: number; run: RunSummary }[], clients: new Set<(entry: { seq: number; run: RunSummary }) => void>() };
const RUN_FEED_KEEP = 500;
manager.subscribeAll((run) => {
  const entry = { seq: ++runFeed.seq, run };
  runFeed.recent.push(entry);
  if (runFeed.recent.length > RUN_FEED_KEEP) runFeed.recent.shift();
  for (const client of runFeed.clients) client(entry);
});

/**
 * Every run's status changes, for the sidebar and notifications. A first connection (or one
 * from before a restart, or that missed too much) starts with the whole list, in step with the
 * stream; a reconnect gets the snapshots it missed.
 */
function streamAllRuns(req: IncomingMessage, res: ServerResponse) {
  const stream = openStream(res);
  const after = lastEventSeq(req);
  const oldest = runFeed.recent[0]?.seq ?? runFeed.seq + 1;
  if (after !== undefined && after >= oldest - 1 && after <= runFeed.seq) {
    stream.send({ type: "hello", epoch: EPOCH, seq: runFeed.seq, resumed: true });
    for (const e of runFeed.recent) if (e.seq > after) stream.send({ type: "run", seq: e.seq, run: e.run }, e.seq);
  } else {
    stream.send({ type: "hello", epoch: EPOCH, seq: runFeed.seq, runs: manager.list() }, runFeed.seq);
  }
  const client = (e: { seq: number; run: RunSummary }) => stream.send({ type: "run", seq: e.seq, run: e.run }, e.seq);
  runFeed.clients.add(client);
  res.on("close", () => runFeed.clients.delete(client));
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
    const claim = !signedIn(req) && mayClaim(req);
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
  if (req.method === "GET" && parts[1] === "doctor" && parts[2] === "git") return send(res, 200, await checkGit());
  if (req.method === "GET" && parts[1] === "doctor") {
    const health = await doctor(manager.quota);
    // Auto stays away from an agent that's signed out, and goes back once it's signed in again.
    for (const entry of health) {
      if (entry.installed && entry.signedIn === false) manager.recordQuota(entry.id, "signed_out", {});
      else if (entry.signedIn === true && manager.quota[entry.id]?.status === "signed_out") manager.recordQuota(entry.id, "allowed", {});
    }
    return send(res, 200, health);
  }
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
      const before = remote;
      // Turning anything off makes new secrets: old links and phones' cookies stop working.
      remote = changeRemote(before, { enabled: body.enabled, lan: body.lan, control: body.control, rotate: !!body.rotate });
      await saveRemote(remote).catch((err) => {
        remote = before; // what's in effect stays what's saved
        logError("Couldn't save the phone settings", err);
        throw new HttpError(500, `Couldn't save the phone settings: ${(err as Error).message}`);
      });
      const signOut = remote.controlToken !== before.controlToken || remote.token !== before.token || (phoneControl(before) && !phoneControl());
      // Listening starts now, so the reply's links (or why there are none) are real.
      if (remote.enabled && remote.lan && !lanServer) await syncLanServer();
      // Signing out waits until after replying (or a dropped request): the phone may be the one
      // turning itself off.
      res.once("close", () => void syncLanServer(signOut));
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
  if (req.method === "GET" && parts[1] === "file") {
    const repo = await requestedRepo(url);
    const content = await readRepoFile(repo, url.searchParams.get("path") ?? "").catch((err: NodeJS.ErrnoException) => {
      throw new HttpError(err.code === "ENOENT" ? 404 : 400, err.code === "ENOENT" ? "File not found" : err.message);
    });
    return send(res, 200, content);
  }
  // The side panel's Notes: one per repository, and a general one.
  if (parts[1] === "notes") {
    if (req.method === "GET" && parts[2] === "all") return send(res, 200, await notes.keys());
    if (req.method === "GET") return send(res, 200, await notes.get(url.searchParams.get("key") ?? ""));
    if (req.method === "POST") {
      const body = await readJson(req);
      if (typeof body.text !== "string") throw new HttpError(400, "Send the note's text");
      return send(res, 200, await attempt(() => notes.set(String(body.key ?? ""), body.text)));
    }
  }
  // Every app started with "Run app", for the side panel's Browser.
  if (req.method === "GET" && parts[1] === "serve") return send(res, 200, manager.devServers.list());
  // The side panel's Terminal: shells that stay open, fed over POST, streamed over SSE.
  if (parts[1] === "shell") {
    const id = parts[2];
    if (!id && req.method === "GET") return send(res, 200, shells.list());
    if (!id && req.method === "POST") {
      const body = await readJson(req);
      const cwd = String(body.cwd ?? "").trim();
      if (!cwd.startsWith("/")) throw new HttpError(400, "The folder must be an absolute path");
      if (!(await stat(cwd).then((s) => s.isDirectory(), () => false))) throw new HttpError(404, "Folder not found");
      // A repository or one of its worktrees: not just any folder a request names.
      await repoRoot(cwd).catch(() => {
        throw new HttpError(400, "The terminal opens in a git repository or one of its worktrees");
      });
      manager.noteActivity(); // commands run on this machine, like Run app
      return send(res, 201, shells.open(cwd));
    }
    if (id && !shells.get(id)) throw new HttpError(404, "That terminal is gone (code-flow restarted?)");
    if (id && req.method === "GET" && parts[3] === "events") {
      const stream = openStream(res);
      stream.send({ type: "hello", shell: shells.get(id), history: shells.history(id) });
      const unsubscribe = shells.subscribe(id, (e: ShellEvent) => stream.send(e));
      res.on("close", () => unsubscribe?.());
      return;
    }
    if (id && req.method === "GET") return send(res, 200, shells.get(id));
    if (id && req.method === "POST" && parts[3] === "input") {
      const body = await readJson(req);
      if (typeof body.text !== "string" || body.text.length > 20_000) throw new HttpError(400, "Send a command");
      if (!shells.write(id, body.text)) throw new HttpError(409, "That shell has exited; open a new one");
      return send(res, 200, shells.get(id));
    }
    if (id && req.method === "DELETE") return send(res, 200, { closed: shells.close(id) });
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
        // The composer asks for its team to be remembered: next time you're in the project it starts
        // from it. A side-panel chat, or a reply (the old run's team), isn't that choice.
        if (run.project && body.remember === true && !body.parentRunId) {
          void projects.remember(run.project, { pattern: run.pattern, roles: requestedRoles(findPattern(run.pattern)!, body.roles), roleSettings: run.roleSettings, agentSettings: validateAgentSettings(body.agentSettings) });
        }
        return send(res, 201, { id: run.id, project: run.project });
      }
    }

    const run = runId ? manager.get(runId) : undefined;
    if (!run) throw new HttpError(404, "Run not found");
    if (req.method === "GET" && parts.length === 3) return send(res, 200, run);
    if (req.method === "GET" && parts[3] === "events") return await streamEvents(req, res, run.id);
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
          // A locked-down run's code is an outsider's, and the app runs on this machine, never in
          // Docker: the same confirmation its checks would need.
          if (run.lockdown && body.allowUntrusted !== true) {
            throw Object.assign(new HttpError(409, `${run.lockdown}. Run app starts that code on this machine, outside any sandbox or container.`), { confirm: "allowUntrusted" });
          }
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
automations.start(envNumber("CODEFLOW_SCHEDULER_TICK_MS", 30_000, { min: 100 }));
void syncLanServer();

function listener(via: Via) {
  return (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res, via).catch((err: Error & { confirm?: string; signIn?: boolean }) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) logError(`${req.method} ${req.url?.split("?")[0]} failed`, err);
      if (res.headersSent) return res.end();
      send(res, status, { error: err.message, confirm: err.confirm, signIn: err.signIn });
    });
  };
}

const server = createServer(listener("local")).listen(PORT, HOST, async () => {
  const agents = await agentAvailability();
  const runs = manager.list();
  console.log(`code-flow running at http://localhost:${PORT}  (${runs.length} runs loaded from ${CODEFLOW_HOME})`);
  console.log(`  Open http://localhost:${PORT}/?token=${auth.token}  (the first browser to open code-flow signs in without it)`);
  for (const a of agents) console.log(`  ${a.available ? "✓" : "✗"} ${a.displayName} (${a.binary})`);
  const gitHealth = await checkGit();
  if (!gitHealth.ok) {
    console.log(`  ✗ ${gitHealth.warning}`);
    logWarn(gitHealth.warning ?? "git check failed");
  }
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
    const result = await removeWorktrees(r.repo, r.worktrees, false).catch((err: Error) => ({ removed: [], deletedBranches: [], failed: [err.message] }));
    if (result.failed.length) manager.log(r.id, `Clean-up couldn't remove everything: ${result.failed.join("; ")}`, "warn");
    if (!result.removed.length) continue;
    removed += result.removed.length;
    done.push(r.id);
    if (!r.archived) manager.setArchived(r.id, true);
    manager.log(r.id, `Cleaned up: removed ${result.removed.length} worktree(s); branches kept`);
  }
  return { runs: done.length, worktrees: removed };
}

// Stop cleanly: running agents are stopped and their runs marked "interrupted" (resumable).
// SIGHUP too: closing the terminal that runs code-flow must not leave its agents running.
let stopping = false;
async function stop(reason: string, code = 0) {
  if (stopping) process.exit(1); // second Ctrl-C: don't wait
  stopping = true;
  console.log(`\nStopping code-flow (${reason}): interrupting running runs so they can be resumed…`);
  logInfo(`Stopping: ${reason}`);
  let automationsSaved: Promise<unknown> = Promise.resolve();
  try {
    server.close();
    lanServer?.close();
    watcher.stop();
    shells.closeAll();
    automationsSaved = automations.stop();
  } catch {
    // still starting up: nothing is listening yet
  }
  await manager.shutdown().catch((err) => logError("Shutdown failed", err));
  await automationsSaved;
  process.exit(code);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => void stop(signal));
}
