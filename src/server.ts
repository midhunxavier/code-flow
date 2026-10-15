import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
import { RunManager, type LoopSettings, type Pattern } from "./engine.js";
import { detectCheckCommand } from "./checks.js";
import { findPattern, patterns } from "./patterns/index.js";
import { listDirectories } from "./fs.js";
import { listBranches, repoRoot, worktreeRoot } from "./git.js";
import { listIssues, listPullRequests } from "./github.js";
import { resolveAuto } from "./routing.js";
import { templates } from "./templates.js";
import { PrWatcher } from "./watch.js";

const manager = new RunManager(findPattern);
const watcher = new PrWatcher(manager);
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

/** Who fills each role; "auto" picks an installed agent whose plan has room (see routing.ts). */
async function validateRoles(pattern: Pattern, input: unknown): Promise<{ roles: Record<string, AgentId[]>; notes: string[] }> {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const requested: Record<string, string[]> = {};
  for (const spec of pattern.roles) {
    const value = raw[spec.id];
    const list = (Array.isArray(value) ? value : value ? [value] : []).filter((v): v is string => v === "auto" || isAgentId(v));
    requested[spec.id] = spec.multiple ? list.slice(0, 6) : list.slice(0, 1);
  }
  const installed = new Set((await agentAvailability()).filter((a) => a.available).map((a) => a.id));
  const resolved = resolveAuto(requested, manager.quota, installed);
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

/** { kind: "issue" | "pr", number, ciLogs? } — where a run starts from on GitHub. */
function validateSource(input: unknown): { kind: "issue" | "pr"; number: number; ciLogs?: boolean } | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const number = Number(raw.number);
  if (raw.kind !== "issue" && raw.kind !== "pr") throw new HttpError(400, "Source must be an issue or a pull request");
  if (!Number.isInteger(number) || number < 1) throw new HttpError(400, "Source needs an issue or PR number");
  return { kind: raw.kind, number, ciLogs: raw.ciLogs === true };
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
  if (req.method === "GET" && parts[1] === "templates") return send(res, 200, templates);
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
        const pattern = findPattern(String(body.pattern ?? ""));
        if (!pattern) throw new HttpError(400, "Unknown pattern");
        const task = String(body.task ?? "").trim();
        const repo = String(body.repo ?? "").trim();
        if (!task) throw new HttpError(400, "Describe the task");
        if (!repo.startsWith("/")) throw new HttpError(400, "Repository must be an absolute path");
        const { roles, notes } = await validateRoles(pattern, body.roles);
        const run = await manager
          .start({
            pattern,
            task,
            repo,
            baseRef: body.baseRef ? String(body.baseRef) : undefined,
            branchPrefix: body.branchPrefix ? String(body.branchPrefix) : undefined,
            context: body.context && typeof body.context === "object" ? body.context : undefined,
            loop: validateLoop(body.loop),
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
            routing: notes,
            roles,
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
    if (req.method === "POST" && parts[3] === "resume") {
      await manager.resume(run.id).catch((err: Error) => {
        throw new HttpError(400, err.message);
      });
      return send(res, 200, { resumed: true });
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
    if (req.method === "POST" && parts[3] === "pr") {
      const body = await readJson(req);
      const prUrl = await attempt(() => manager.pullRequest(run.id, { branch: String(body.branch ?? ""), into: String(body.into ?? "") }));
      return send(res, 200, { url: prUrl });
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
      const watch = await attempt(async () => manager.watchPr(run.id, { branch, agent: body.agent, maxFixes: Number(body.maxFixes) || undefined }));
      void watcher.poll();
      return send(res, 200, watch);
    }
  }

  throw new HttpError(404, "Not found");
}

await manager.load();
watcher.start();

const server = createServer((req, res) => {
  handle(req, res).catch((err: Error) => {
    if (res.headersSent) return res.end();
    send(res, err instanceof HttpError ? err.status : 500, { error: err.message });
  });
}).listen(PORT, HOST, async () => {
  const agents = await agentAvailability();
  const runs = manager.list();
  console.log(`code-flow running at http://localhost:${PORT}  (${runs.length} runs loaded from ${CODEFLOW_HOME})`);
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

// Stop cleanly: running agents are stopped and their runs marked "interrupted" (resumable).
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (stopping) process.exit(1); // second Ctrl-C: don't wait
    stopping = true;
    console.log("\nStopping code-flow: interrupting running runs so they can be resumed…");
    server.close();
    watcher.stop();
    await manager.shutdown();
    process.exit(0);
  });
}
