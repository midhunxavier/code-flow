import { MAX_EXECUTION_BUDGET } from "../execution-budget.js";
import { TEAM_JOIN_SETTINGS } from "./settings-location.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import { isAgentId, validateAgentSettings } from "../adapters/index.js";
import type { AgentId, AgentSettings } from "../adapters/index.js";
import type { LoopSettings, Pattern, RunManager } from "../engine.js";
import { readJson, send } from "../http.js";
import type { Trust } from "../repo-config.js";
import type { TeamLink, TeamLinkState } from "./link.js";
import { CHECKPOINT_ID, CollabError, collabErrorBody, currentAttempt, validatePathId } from "./model.js";
import type { RunnerPublic } from "./model.js";
import type { CollabRunner, DraftTaskInput, LocalAttemptRecord, StartAttemptInput } from "./runner.js";
import type { CollabStore } from "./store.js";

/**
 * `/api/team-link/*`: the owner's routes for this computer as a runner. They are local and owner-only in
 * both modes: linked (the hub is elsewhere, the runner publishes to it) and hub (this instance is the team
 * server and its owner executes in-process through LocalHub). Bodies are validated here; the runner and the
 * link answer with CollabError, whose status is the HTTP status.
 */
export interface TeamLinkApiHost {
  link: TeamLink; runner: CollabRunner; store: CollabStore; manager: Pick<RunManager, "get">;
  findPattern: (id: string) => Pattern | undefined;
  /** Agent ids this computer can run (installed CLIs); roles name only these. */
  agents: () => AgentId[];
  /** The name this instance shows as a hub (its owner's display name), reported while not linked. */
  hubName?: string;
}
export interface TeamLinkInfo extends TeamLinkState { runner?: RunnerPublic }
export type LocalAttemptView = LocalAttemptRecord & { runStatus?: string };

const BODY_LIMIT = 16 * 1024, START_BODY_LIMIT = 64 * 1024, BODY_TIMEOUT = { timeoutMs: 10_000 };
const TRUSTS: readonly Trust[] = ["safe", "standard", "trusted", "full"], START_FIELDS = ["repo", "pattern", "roles", "agentSettings", "roleSettings", "trust", "loop", "fromCheckpointId"], LOOP_FIELDS = ["check", "setup", "maxMinutes", "maxSteps"];
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const absent = (v: unknown): v is undefined | null | "" => v === undefined || v === null || v === "";
const body = (req: IncomingMessage, limit = BODY_LIMIT): Promise<Record<string, unknown>> => readJson(req, limit, BODY_TIMEOUT);
function assertKeys(value: Record<string, unknown>, allowed: readonly string[], what: string) { const extra = Object.keys(value).find((key) => !allowed.includes(key)); if (extra !== undefined) throw new CollabError(`Unknown ${what} field ${JSON.stringify(extra.slice(0, 40))}; the allowed fields are ${allowed.join(", ")}`); }
function repoPath(value: unknown, required: boolean): string | undefined { if (absent(value)) { if (required) throw new CollabError("Send the absolute path of your clone as repo"); return undefined; } if (typeof value !== "string" || !isAbsolute(value) || value.length > 4096) throw new CollabError("Repository must be an absolute path"); return value; }

/** Every role the pattern declares gets its agents; ids must be installed here, since this computer runs them. */
export function validateRoles(pattern: Pattern, input: unknown, installed: readonly AgentId[]): Record<string, AgentId[]> {
  if (!object(input)) throw new CollabError("Send roles as { <role>: [agent ids] }");
  const known = pattern.roles.map((spec) => spec.id), extra = Object.keys(input).find((key) => !known.includes(key)); if (extra !== undefined) throw new CollabError(`The ${pattern.name} pattern has no role ${JSON.stringify(extra.slice(0, 40))}; its roles are ${known.join(", ")}`);
  const roles: Record<string, AgentId[]> = {};
  for (const spec of pattern.roles) {
    const raw = input[spec.id], list = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw]; if (list.length > 6) throw new CollabError(`Pick at most 6 agents for "${spec.label}"`);
    const agents: AgentId[] = []; for (const entry of list) { if (!isAgentId(entry)) throw new CollabError(`Pick an installed agent for "${spec.label}" (claude, codex or agy)`); if (!installed.includes(entry)) throw new CollabError(`${entry} is not installed or not on PATH on this computer`); if (!agents.includes(entry)) agents.push(entry); }
    const chosen = spec.multiple ? agents : agents.slice(0, 1); if (!chosen.length && !spec.optional) throw new CollabError(`Pick an agent for "${spec.label}"`); roles[spec.id] = chosen;
  }
  return roles;
}
function settings(value: unknown, label: string): AgentSettings { if (!object(value)) throw new CollabError(`Send ${label} as { <agent>: { model?, effort? } }`); try { return validateAgentSettings(value); } catch (error) { throw new CollabError(error instanceof Error ? error.message : String(error)); } }
function roleSettings(value: unknown): Record<string, AgentSettings> { if (!object(value)) throw new CollabError("Send roleSettings as { <role>: { <agent>: { model?, effort? } } }"); const out: Record<string, AgentSettings> = {}; for (const [role, entry] of Object.entries(value)) { if (!/^[\w-]{1,40}$/.test(role)) throw new CollabError(`Role settings name an unknown role ${JSON.stringify(role.slice(0, 40))}`); const valid = settings(entry, `roleSettings.${role}`); if (Object.keys(valid).length) out[role] = valid; } return out; }
/** The engine's LoopSettings are partial on start, so only the four fields the team UI offers are accepted; commands are the owner's own shell lines. */
function loop(value: unknown): Partial<LoopSettings> {
  if (!object(value)) throw new CollabError("Send loop as { check?, setup?, maxMinutes?, maxSteps? }"); assertKeys(value, LOOP_FIELDS, "loop"); const out: Partial<LoopSettings> = {};
  const command = (key: "check" | "setup") => { if (absent(value[key])) return; const line = value[key]; if (typeof line !== "string" || line.length > 1000 || /[\r\n\x00]/.test(line)) throw new CollabError(`The ${key} command must be a single line of at most 1000 characters`); if (line.trim()) out[key] = line.trim(); };
  const number = (key: "maxMinutes" | "maxSteps", min: number, max: number) => { if (absent(value[key])) return; const n = Number(value[key]); if (!Number.isFinite(n)) throw new CollabError(`Send ${key} as a number between ${min} and ${max}`); out[key] = Math.min(max, Math.max(min, Math.round(n))); };
  command("check"); command("setup"); number("maxMinutes", 1, MAX_EXECUTION_BUDGET.maxMinutes); number("maxSteps", 1, MAX_EXECUTION_BUDGET.maxSteps); return out;
}
export function validateStartBody(raw: Record<string, unknown>, host: Pick<TeamLinkApiHost, "findPattern" | "agents">): StartAttemptInput {
  assertKeys(raw, START_FIELDS, "start"); const pattern = typeof raw.pattern === "string" && /^[a-z0-9-]{1,40}$/.test(raw.pattern) ? host.findPattern(raw.pattern) : undefined; if (!pattern) throw new CollabError("Unknown pattern");
  const input: StartAttemptInput = { pattern, roles: validateRoles(pattern, raw.roles ?? {}, host.agents()) }, repo = repoPath(raw.repo, false); if (repo) input.repo = repo;
  if (!absent(raw.trust)) { if (typeof raw.trust !== "string" || !(TRUSTS as readonly string[]).includes(raw.trust)) throw new CollabError("Choose agent permissions: safe, standard, trusted or full"); input.trust = raw.trust as Trust; }
  if (!absent(raw.agentSettings)) input.agentSettings = settings(raw.agentSettings, "agentSettings"); if (!absent(raw.roleSettings)) input.roleSettings = roleSettings(raw.roleSettings); if (!absent(raw.loop)) input.loop = loop(raw.loop);
  if (!absent(raw.fromCheckpointId)) { if (typeof raw.fromCheckpointId !== "string" || !CHECKPOINT_ID.test(raw.fromCheckpointId)) throw new CollabError("Send the checkpoint id as 32 lowercase hexadecimal characters"); input.fromCheckpointId = raw.fromCheckpointId; }
  return input;
}

export function validateDraftBody(raw: Record<string, unknown>, installed: readonly AgentId[]): DraftTaskInput {
  assertKeys(raw, ["projectId", "repository", "idea", "agent", "repo", "baseRef", "agentSettings"], "draft");
  const text = (key: string, max: number, required = true) => {
    const value = raw[key];
    if (!required && absent(value)) return undefined;
    if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new CollabError(`Send ${key} as text of 1–${max} characters`);
    return value.trim();
  };
  if (!isAgentId(raw.agent) || !installed.includes(raw.agent)) throw new CollabError("Choose an installed drafting agent on this computer");
  return { projectId: text("projectId", 100)!, repository: text("repository", 64)!, idea: text("idea", 16384)!, agent: raw.agent,
    repo: repoPath(raw.repo, false), baseRef: text("baseRef", 100, false),
    ...(!absent(raw.agentSettings) ? { agentSettings: settings(raw.agentSettings, "agentSettings") } : {}),
  };
}

/** `GET /api/team-link`: the link plus, best effort, what the hub knows about this runner (online, revoked). */
export async function linkInfo(host: TeamLinkApiHost): Promise<TeamLinkInfo> {
  const state = host.link.state(), info: TeamLinkInfo = { ...state };
  if (!state.linked && host.hubName && !info.hubName) info.hubName = host.hubName;
  if (state.linked) { try { const me = await host.runner.hub.me(); const runner = me.runners.find((entry) => entry.id === state.runnerId); if (runner) info.runner = runner; else { info.revoked = true; info.connection = "offline"; info.error = `The team server no longer lists this computer's runner; connect this computer again in ${TEAM_JOIN_SETTINGS}`; } } catch (error) { if (error instanceof CollabError && error.status === 401) { info.revoked = true; info.connection = "offline"; info.error = error.message; } else info.error ??= error instanceof Error ? error.message : String(error); } }
  return info;
}
async function dispatch(req: IncomingMessage, res: ServerResponse, _url: URL, parts: readonly string[], host: TeamLinkApiHost): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase(), [, , head, id, action] = parts;
  if (head === undefined && parts.length === 2) {
    if (method === "GET") return send(res, 200, await linkInfo(host));
  }
  // Connection enrollment and removal belong to TeamConnections in the HTTP router.
  if (head === "draft" && parts.length === 3 && method === "POST") return send(res, 201, await host.runner.draftTask(validateDraftBody(await body(req, START_BODY_LIMIT), host.agents())));
  // On demand what the recovery timer does every minute: a board that shows this computer's attempt as busy with nothing running behind it is settled without waiting for a restart or a reconnect.
  if (head === "reconcile" && parts.length === 3 && method === "POST") return send(res, 200, await host.runner.reconcile());
  if (head === "mappings" && parts.length === 3 && method === "PUT") { const raw = await body(req); assertKeys(raw, ["projectId", "repository", "path"], "mapping"); const mappings = await host.link.setMapping(raw.projectId, raw.repository, raw.path); return send(res, 200, { mappings }); }
  if (head === "attempts" && parts.length === 3 && method === "GET") { const attempts = await host.runner.attempts(); return send(res, 200, attempts.map((record): LocalAttemptView => { const run = record.runId ? host.manager.get(record.runId) : undefined; return run ? { ...record, runStatus: run.status } : record; })); }
  if (head === "tasks" && id !== undefined && action !== undefined && parts.length === 5 && method === "POST") {
    const taskId = validatePathId(id, "task id"), runner = host.runner;
    switch (action) {
      case "start": { const input = validateStartBody(await body(req, START_BODY_LIMIT), host); return send(res, 201, await runner.startAttempt(taskId, input)); }
      case "stop": { const record = await runner.attemptForTask(taskId, ["claimed", "running"]); if (!record) throw new CollabError("No attempt of this task is running on this computer", 409); return send(res, 200, await runner.stopAttempt(record.attemptId)); }
      // Resume continues the attempt the task page shows (the current one, else the latest), never an older paused record of this computer behind a newer attempt: that line of work is history, and reviving it would continue from an older base past the task's latest outcome.
      case "resume": { const task = await runner.hub.task(taskId), shown = currentAttempt(task) ?? task.attempts[task.attempts.length - 1], record = shown ? (await runner.attempts()).find((entry) => entry.attemptId === shown.id && (entry.state === "paused" || entry.state === "stopped" || entry.state === "unknown")) : undefined; if (!record) throw new CollabError("No paused attempt of this task is on this computer; start a new attempt instead", 409); return send(res, 200, await runner.resumeAttempt(record.attemptId)); }
      case "handover": { const raw = await body(req); assertKeys(raw, ["to", "note", "includeUncommitted"], "hand-over"); if (typeof raw.to !== "string" || !raw.to) throw new CollabError("Choose the teammate to hand over to"); if (raw.includeUncommitted !== undefined && typeof raw.includeUncommitted !== "boolean") throw new CollabError("Send includeUncommitted as true or false"); if (raw.note !== undefined && raw.note !== null && typeof raw.note !== "string") throw new CollabError("Enter the note as text"); return send(res, 200, await runner.handOver(taskId, { to: raw.to, note: typeof raw.note === "string" ? raw.note : "", includeUncommitted: raw.includeUncommitted === true })); }
      case "accept": { const raw = await body(req); assertKeys(raw, ["handoffId", "repo"], "accept"); const handoffId = validatePathId(raw.handoffId, "hand-over id"), repo = repoPath(raw.repo, false); return send(res, 200, await runner.acceptHandoff(taskId, handoffId, repo ? { repo } : {})); }
    }
  }
  if (head === "checkpoints" && id !== undefined && action === "fetch" && parts.length === 5 && method === "POST") { const raw = await body(req); assertKeys(raw, ["repo"], "fetch"); const repo = repoPath(raw.repo, true)!; return send(res, 200, await host.runner.fetchCheckpoint(validatePathId(id, "checkpoint id"), { repo })); }
  throw new CollabError("Unknown team link operation", 404);
}
/** CollabError (from the link, the runner, the store or the checkpoint helpers) answers with its status; anything else is the server's to report. */
export async function handleTeamLinkApi(req: IncomingMessage, res: ServerResponse, url: URL, parts: readonly string[], host: TeamLinkApiHost): Promise<void> {
  try { await dispatch(req, res, url, parts, host); }
  catch (error) { if (error instanceof CollabError) return send(res, error.status, collabErrorBody(error)); throw error; }
}
