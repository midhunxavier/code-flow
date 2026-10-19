import { constants } from "node:fs";
import { mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CODEFLOW_HOME } from "../config.js";
import { readJson, send } from "../http.js";
import { logError } from "../log.js";
import { Shells } from "../shell.js";
import { roleAtLeast, type SharedUser } from "../shared-accounts.js";
import { CollabError, type CollabActor } from "./model.js";

export interface TerminalGrant { projectId: string; enabled: boolean; userIds: string[] }
export interface TeamTerminal { id: string; projectId: string; repository: string; userId: string; displayName: string; startedAt: number; status: "running" | "exited" }
export interface TerminalAudit { at: number; action: "opened" | "closed"; session: TeamTerminal; by: string; reason?: string }
interface State { version: 1; revision: number; grants: TerminalGrant[]; audit: TerminalAudit[] }
interface Session extends TeamTerminal { cwd: string; accountRevision: number; lastInput: number }
export interface TeamTerminalOptions {
  users: () => SharedUser[]; projectRepos: (id: string) => readonly string[] | undefined;
  resolveRepo: (projectId: string, key: string) => string | undefined; enabled: () => boolean;
  changed: (projectId: string) => void; activity?: () => void; file?: string; shells?: Shells; now?: () => number;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => { if (Object.keys(v).some((key) => !allowed.includes(key))) throw new CollabError("Unknown terminal field"); };
function grant(value: unknown): TerminalGrant {
  if (!object(value)) throw new CollabError("Invalid terminal grant"); keys(value, ["projectId", "enabled", "userIds"]);
  if (!id(value.projectId) || typeof value.enabled !== "boolean" || !Array.isArray(value.userIds) || value.userIds.length > 128 || !value.userIds.every(id) || new Set(value.userIds).size !== value.userIds.length) throw new CollabError("Choose a project and its permitted teammates");
  return structuredClone(value) as unknown as TerminalGrant;
}
function size(raw: Record<string, unknown>) {
  if (!Number.isInteger(raw.cols) || !Number.isInteger(raw.rows) || Number(raw.cols) < 2 || Number(raw.cols) > 500 || Number(raw.rows) < 1 || Number(raw.rows) > 200) throw new CollabError("Terminal size must be 2–500 columns and 1–200 rows");
  return { cols: raw.cols as number, rows: raw.rows as number };
}
const metadata = ({ id, projectId, repository, userId, displayName, startedAt, status }: TeamTerminal): TeamTerminal => ({ id, projectId, repository, userId, displayName, startedAt, status });
export const TERMINAL_IDLE_MS = 30 * 60_000;

/** Explicit trusted-host access. Project grants select a starting folder, not an OS sandbox. */
export class TeamTerminals {
  private state: State = { version: 1, revision: 0, grants: [], audit: [] };
  private sessions = new Map<string, Session>(); private listeners = new Map<string, Set<() => void>>();
  private ready = false; private closed = false; private chain: Promise<unknown> = Promise.resolve(); private timer?: NodeJS.Timeout;
  private readonly shells: Shells; private readonly file: string; private readonly now: () => number;
  constructor(private readonly options: TeamTerminalOptions) { this.shells = options.shells ?? new Shells(); this.file = options.file ?? join(CODEFLOW_HOME, "terminal-access.json"); this.now = options.now ?? Date.now; }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const next = this.chain.catch(() => {}).then(fn); this.chain = next; return next; }
  private require() { if (!this.ready || this.closed) throw new CollabError("Team terminals are unavailable", 503); }
  async load() {
    try {
      const handle = await open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); let raw: unknown;
      try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("Invalid terminal access storage"); raw = JSON.parse(await handle.readFile("utf8")); } finally { await handle.close(); }
      if (!object(raw) || raw.version !== 1 || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0 || !Array.isArray(raw.grants) || raw.grants.length > 200 || !Array.isArray(raw.audit) || raw.audit.length > 500) throw new Error("Invalid terminal access storage");
      raw.grants.forEach(grant); if (new Set(raw.grants.map((g) => g.projectId)).size !== raw.grants.length) throw new Error("Duplicate terminal grants");
      for (const event of raw.audit) if (!object(event) || !["opened", "closed"].includes(String(event.action)) || !Number.isFinite(event.at) || !id(event.by) || !object(event.session) || !id(event.session.id) || !id(event.session.projectId) || !id(event.session.userId) || !id(event.session.repository) || typeof event.session.displayName !== "string" || !Number.isFinite(event.session.startedAt) || !["running", "exited"].includes(String(event.session.status)) || event.reason !== undefined && typeof event.reason !== "string") throw new Error("Invalid terminal audit record");
      this.state = raw as unknown as State;
      // Shell processes are never resumed after a server restart.
      const openSessions = new Map<string, TeamTerminal>();
      for (const event of this.state.audit) { if (event.action === "opened") openSessions.set(event.session.id, event.session); else openSessions.delete(event.session.id); }
      for (const session of openSessions.values()) this.record("closed", session, "owner", "Server restarted");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await this.persist(); this.ready = true;
  }
  start() { this.timer ??= setInterval(() => void this.reap().catch((error) => logError("Team terminal cleanup failed", error)), 1000); this.timer.unref(); }
  active() { return this.sessions.size; }
  private user(userId: string) { return this.options.users().find((user) => user.id === userId && user.enabled); }
  private allowed(userId: string, projectId: string) {
    const user = this.user(userId), g = this.state.grants.find((g) => g.projectId === projectId);
    return !!this.options.projectRepos(projectId) && !!user && roleAtLeast(user.roles[projectId], "contributor") && !!g?.enabled && g.userIds.includes(userId) && this.options.enabled();
  }
  private valid(session: Session) {
    return this.allowed(session.userId, session.projectId) && this.user(session.userId)?.revision === session.accountRevision && this.options.resolveRepo(session.projectId, session.repository) === session.cwd && !!this.options.projectRepos(session.projectId)?.includes(session.cwd);
  }
  view(actor: CollabActor) {
    this.require(); const owner = actor.kind === "owner";
    const visible = (p: string) => !!this.options.projectRepos(p) && (owner || !!this.user(actor.userId)?.roles[p]);
    return { revision: this.state.revision, available: this.options.enabled(),
      grants: this.state.grants.filter((g) => visible(g.projectId)).map((g) => owner ? structuredClone(g) : { projectId: g.projectId, allowed: this.allowed(actor.userId, g.projectId) }),
      sessions: [...this.sessions.values()].filter((s) => owner || s.userId === actor.userId && visible(s.projectId) && this.valid(s)).map(metadata),
      audit: owner ? structuredClone(this.state.audit.slice(-100)) : [], idleMinutes: 30, maxPerUser: 2,
    };
  }
  configure(raw: Record<string, unknown>) { return this.serial(async () => {
    this.require(); keys(raw, ["revision", "grant"]); if (raw.revision !== this.state.revision) throw new CollabError("Terminal settings changed; reload before saving", 409);
    const next = grant(raw.grant); if (!this.options.projectRepos(next.projectId)) throw new CollabError("Project not found", 404);
    if (next.userIds.some((uid) => { const user = this.user(uid); return !user || !roleAtLeast(user.roles[next.projectId], "contributor"); })) throw new CollabError("Grant terminals only to enabled project contributors or maintainers");
    if (!this.state.grants.some((g) => g.projectId === next.projectId) && this.state.grants.length >= 200) throw new CollabError("At most 200 project terminal policies may be configured");
    this.state.grants = [...this.state.grants.filter((g) => g.projectId !== next.projectId), next]; this.state.revision++;
    await this.persist(); await this.reapNow(); this.options.changed(next.projectId); return this.view({ kind: "owner", userId: "owner", displayName: "Owner" });
  }); }
  open(actor: CollabActor, raw: Record<string, unknown>, authorize: () => void) { return this.serial(async () => {
    this.require(); authorize(); keys(raw, ["projectId", "repository", "cols", "rows"]);
    if (actor.kind !== "member" || actor.via !== "browser") throw new CollabError("Use your teammate account to open a team terminal", 403);
    if (!id(raw.projectId) || !id(raw.repository) || !this.allowed(actor.userId, raw.projectId)) throw new CollabError("The owner has not granted terminal access to this project", 403);
    const cwd = this.options.resolveRepo(raw.projectId, raw.repository);
    if (!cwd || !this.options.projectRepos(raw.projectId)?.includes(cwd) || await realpath(cwd).catch(() => undefined) !== cwd) throw new CollabError("The host repository mapping is unavailable", 409);
    const dimensions = size(raw); await this.reapNow();
    if (this.sessions.size >= 8 || [...this.sessions.values()].filter((s) => s.userId === actor.userId).length >= 2) throw new CollabError("Close a terminal first: at most two per teammate and eight on the host", 409);
    if (!await this.shells.interactive()) throw new CollabError("Interactive terminals require Python 3 PTY support on the host", 409);
    authorize(); if (!this.allowed(actor.userId, raw.projectId)) throw new CollabError("Terminal permission changed", 403);
    const user = this.user(actor.userId)!, revision = user.revision;
    const shell = await this.shells.open(cwd, { pty: true, ...dimensions });
    const session: Session = { id: shell.id, projectId: raw.projectId, repository: raw.repository, userId: user.id, displayName: user.displayName, startedAt: this.now(), lastInput: this.now(), accountRevision: revision, cwd, status: shell.status };
    try { authorize(); if (!this.valid(session) || !shell.interactive || this.closed) throw new CollabError("Terminal access changed while opening", 403); }
    catch (error) { this.shells.close(shell.id); throw error; }
    this.sessions.set(shell.id, session); this.record("opened", session, actor.userId); await this.persist();
    this.options.activity?.(); this.options.changed(session.projectId); return metadata(session);
  }); }
  private own(actor: CollabActor, sessionId: string) {
    this.require(); const session = this.sessions.get(sessionId);
    if (!session || session.userId !== actor.userId || !this.valid(session)) throw new CollabError("Terminal unavailable", 404);
    return session;
  }
  input(actor: CollabActor, sessionId: string, raw: Record<string, unknown>) {
    const session = this.own(actor, sessionId); keys(raw, ["data", "binary"]);
    if ((raw.data === undefined) === (raw.binary === undefined)) throw new CollabError("Send data or binary keystrokes");
    const data = raw.data ?? raw.binary;
    if (typeof data !== "string" || Buffer.byteLength(data) > 32 * 1024 || raw.binary !== undefined && /[^\x00-\xff]/.test(data)) throw new CollabError("Send at most 32 KiB of terminal input");
    if (this.shells.pendingInputBytes(sessionId) > 128 * 1024) throw new CollabError("Terminal input is backed up; wait before sending more", 429);
    if (!this.shells.type(sessionId, data, raw.binary === undefined ? "utf8" : "latin1")) throw new CollabError("Terminal has exited", 409);
    session.lastInput = this.now(); this.options.activity?.(); return { ok: true };
  }
  resize(actor: CollabActor, sessionId: string, raw: Record<string, unknown>) { this.own(actor, sessionId); keys(raw, ["cols", "rows"]); const s = size(raw); if (!this.shells.resize(sessionId, s.cols, s.rows)) throw new CollabError("Terminal has exited", 409); return { ok: true }; }
  private record(action: TerminalAudit["action"], session: TeamTerminal, by: string, reason?: string) { this.state.audit.push({ at: this.now(), action, session: metadata(session), by, ...(reason ? { reason } : {}) }); this.state.audit = this.state.audit.slice(-500); }
  private end(session: Session, by: string, reason: string) {
    this.shells.close(session.id); this.sessions.delete(session.id);
    for (const listener of this.listeners.get(session.id) ?? []) listener(); this.listeners.delete(session.id);
    this.record("closed", session, by, reason); this.options.changed(session.projectId);
  }
  closeSession(actor: CollabActor, sessionId: string) { return this.serial(async () => {
    this.require(); const session = this.sessions.get(sessionId);
    if (!session || actor.kind !== "owner" && session.userId !== actor.userId) throw new CollabError("Terminal unavailable", 404);
    this.end(session, actor.userId, "Closed by user"); await this.persist(); return { closed: true };
  }); }
  reap() { return this.serial(() => this.reapNow()); }
  private async reapNow() {
    if (!this.ready || this.closed) return; let changed = false;
    for (const session of this.sessions.values()) {
      const shell = this.shells.get(session.id);
      const reason = !this.valid(session) ? "Access revoked or repository changed" : this.now() - session.lastInput >= TERMINAL_IDLE_MS ? "No keyboard input for 30 minutes" : !shell || shell.status === "exited" ? "Shell exited" : undefined;
      if (reason) { this.end(session, "owner", reason); changed = true; }
    }
    if (changed) await this.persist();
  }
  watch(actor: CollabActor, sessionId: string, res: ServerResponse, authorize: () => void) {
    this.own(actor, sessionId); authorize();
    const watching = this.listeners.get(sessionId) ?? new Set<() => void>();
    if (watching.size >= 2) throw new CollabError("This terminal is already open in two tabs", 429);
    let closed = false, stop: (() => void) | undefined, timer: NodeJS.Timeout | undefined;
    const close = () => { if (closed) return; closed = true; stop?.(); if (timer) clearInterval(timer); watching.delete(close); res.destroy(); };
    watching.add(close); this.listeners.set(sessionId, watching); res.once("close", close);
    const check = () => { authorize(); this.own(actor, sessionId); };
    const emit = (event: unknown) => { if (closed) return; try { check(); if (res.writableLength > 512 * 1024) return close(); res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { close(); } };
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "connection": "keep-alive", "x-accel-buffering": "no" }); res.flushHeaders();
    stop = this.shells.subscribe(sessionId, emit);
    emit({ type: "hello", shell: this.shells.get(sessionId), history: this.shells.history(sessionId) });
    if (closed) { stop?.(); return; }
    timer = setInterval(() => { try { check(); if (res.writableLength > 512 * 1024) return close(); res.write(": connected\n\n"); } catch { close(); } }, 1000); timer.unref();
  }
  private async persist() {
    const temp = `${this.file}.${randomBytes(8).toString("hex")}.tmp`;
    try { await mkdir(dirname(this.file), { recursive: true, mode: 0o700 }); const handle = await open(temp, "wx", 0o600); try { await handle.writeFile(JSON.stringify(this.state)); await handle.sync(); } finally { await handle.close(); } await rename(temp, this.file); if (process.platform !== "win32") { const folder = await open(dirname(this.file), "r"); try { await folder.sync(); } finally { await folder.close(); } } }
    catch (error) { this.ready = false; for (const session of [...this.sessions.values()]) this.end(session, "owner", "Audit storage unavailable"); throw error; }
    finally { await rm(temp, { force: true }).catch(() => {}); }
  }
  async close() { if (this.timer) clearInterval(this.timer); this.closed = true; await this.chain.catch(() => {}); for (const session of [...this.sessions.values()]) this.end(session, "owner", "Server stopped"); if (this.ready) await this.persist(); this.shells.closeAll(); }
}
export async function handleTeamTerminals(req: IncomingMessage, res: ServerResponse, parts: readonly string[], service: TeamTerminals, current: () => CollabActor, mutation: () => void) {
  try {
    const method = req.method ?? "GET", actor = current();
    if (method !== "GET") mutation();
    const body = () => readJson(req, 192 * 1024, { timeoutMs: 10_000 });
    if (parts.length === 2 && method === "GET") return send(res, 200, service.view(actor));
    if (parts.length === 2 && method === "POST") { const raw = await body(); return send(res, 201, await service.open(current(), raw, () => { current(); })); }
    if (parts.length === 3 && parts[2] === "settings" && method === "PUT") { if (actor.kind !== "owner") throw new CollabError("Only the host owner may grant terminals", 403); const raw = await body(); current(); return send(res, 200, await service.configure(raw)); }
    const sessionId = parts[2];
    if (sessionId && parts.length === 3 && method === "DELETE") { const raw = await body(); keys(raw, []); return send(res, 200, await service.closeSession(current(), sessionId)); }
    if (sessionId && parts.length === 4 && method === "GET" && parts[3] === "events") return service.watch(actor, sessionId, res, () => { current(); });
    if (sessionId && parts.length === 4 && method === "POST" && ["input", "resize"].includes(parts[3]!)) { const raw = await body(); return send(res, 200, parts[3] === "input" ? service.input(current(), sessionId, raw) : service.resize(current(), sessionId, raw)); }
    throw new CollabError("Unknown team terminal operation", 404);
  } catch (error) { if (error instanceof CollabError) return send(res, error.status, { error: error.message }); throw error; }
}
