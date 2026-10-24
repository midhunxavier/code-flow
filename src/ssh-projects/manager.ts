import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEFLOW_HOME } from "../config.js";
import { HttpError, readJson } from "../http.js";
import { sshAliases } from "./config.js";
import { SshGateway, parseRuntime } from "./gateway.js";
import { SshTransport, validSshHost, validSshOptions, type SshOptions } from "./transport.js";

export interface ComputerProjects { id: string; name: string; projects: { id: string; name: string }[]; error?: string }
interface Host extends SshOptions { id: string; name: string; sshHost: string }
interface Session { transport: SshTransport; gateway: SshGateway }
export class SshProjects {
  private hosts: Host[] = [];
  private loaded?: Promise<void>;
  private writes: Promise<unknown> = Promise.resolve();
  private sessions = new Map<string, Session>();
  private pending = new Map<string, Promise<Session>>();
  private closed = false;
  private teamRemoving = new Set<string>();
  private teamSessions = new Map<string, Session>();
  private teamPending = new Map<string, Promise<{ remotePort: number; currentVersion: boolean }>>();
  private file: string;
  constructor(private readonly options: { home?: string; sshBinary?: string; packagePath?: string; configPath?: string; localProjects?: () => { id: string; name: string }[]; canBrowse?: () => boolean }) { this.file = join(options.home ?? CODEFLOW_HOME, "ssh-hosts.json"); }
  private load() {
    return this.loaded ??= readFile(this.file, "utf8").then((text) => {
      const raw = JSON.parse(text);
      if (!raw || raw.version !== 1 || !Array.isArray(raw.hosts) || raw.hosts.length > 32 || raw.hosts.some((host: Host) => !host || typeof host !== "object" || !/^[a-f0-9]{16}$/.test(host.id) || !validSshHost(host.sshHost) || !validSshOptions(host) || typeof host.name !== "string" || !host.name || host.name.length > 80) || new Set(raw.hosts.map((host: Host) => host.id)).size !== raw.hosts.length) throw new Error("Repair the SSH connections file before continuing");
      this.hosts = raw.hosts;
    }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
  async list() {
    await this.load();
    return { hosts: this.hosts.map((host) => ({ ...host, state: this.pending.has(host.id) ? "connecting" : this.sessions.has(host.id) ? this.sessions.get(host.id)!.gateway.error ? "disconnected" : "connected" : "disconnected", error: this.sessions.get(host.id)?.gateway.error })), aliases: await sshAliases(this.options.configPath) };
  }
  private change(operation: () => void) {
    const work = this.writes.catch(() => undefined).then(async () => {
      await this.load(); const before = this.hosts.slice(); operation();
      try { await mkdir(this.options.home ?? CODEFLOW_HOME, { recursive: true, mode: 0o700 }); const temp = `${this.file}.tmp`; await writeFile(temp, JSON.stringify({ version: 1, hosts: this.hosts }), { mode: 0o600 }); await rename(temp, this.file); }
      catch (error) { this.hosts = before; throw error; }
    });
    this.writes = work; return work;
  }
  async add(body: { name?: unknown; sshHost?: unknown; port?: unknown; identityFile?: unknown }) {
    if (!validSshHost(body.sshHost)) throw new HttpError(400, "Enter an SSH alias or user@hostname.");
    if (!validSshOptions(body)) throw new HttpError(400, "Use a port from 1 to 65535 and an absolute or ~/ SSH key path without control characters or % tokens");
    const name = typeof body.name === "string" ? body.name.trim() : body.sshHost;
    if (!name || name.length > 80) throw new HttpError(400, "Name the server using at most 80 characters");
    const host: Host = { id: randomBytes(8).toString("hex"), name, sshHost: body.sshHost, ...(body.port === undefined ? {} : { port: body.port as number }), ...(body.identityFile === undefined ? {} : { identityFile: body.identityFile as string }) };
    await this.change(() => { if (this.hosts.length >= 32) throw new HttpError(409, "Remove an unused SSH connection first (32 maximum)"); if (this.hosts.some((item) => item.sshHost === host.sshHost && item.port === host.port && item.identityFile === host.identityFile)) throw new HttpError(409, "This SSH host is already saved"); this.hosts.push(host); }); return host;
  }
  private async setup(host: Host, remotePort?: number) {
    const [code, payload] = await Promise.all([readFile(new URL("./bootstrap.mjs", import.meta.url), "utf8"), readFile(this.options.packagePath ?? fileURLToPath(new URL("../../dist/remote-host.json", import.meta.url)), "utf8").catch(() => { throw new Error("Build the SSH host package with npm run build:host, then connect again."); })]);
    if (payload.length > 32 * 1024 * 1024) throw new Error("Remote host package exceeds 32 MiB");
    const transport = new SshTransport(host.sshHost, this.options.sshBinary, host); await transport.init();
    try { const runtime = parseRuntime(await transport.bootstrap(code, remotePort === undefined ? payload : JSON.stringify({ ...JSON.parse(payload), remotePort, serviceBootstrap: code }), remotePort !== undefined)); return { transport, runtime, currentVersion: runtime.version === JSON.parse(payload).version }; }
    catch (error) { await transport.close(); throw error; }
  }
  async connect(id: string) {
    await this.load();
    if (this.closed) throw new HttpError(503, "The local app is shutting down");
    const host = this.hosts.find((item) => item.id === id); if (!host) throw new HttpError(404, "SSH connection not found");
    let session = this.sessions.get(id);
    if (session) await session.gateway.ensureConnected();
    if (!session) {
      let pending = this.pending.get(id);
      if (!pending) {
        if (this.sessions.size + this.pending.size >= 8) throw new HttpError(409, "Disconnect an unused server first (8 active connections maximum)");
        pending = (async () => {
          const initial = await this.setup(host);
          const state: Session = { transport: initial.transport, gateway: undefined! };
          let reconnecting: Promise<typeof initial> | undefined;
          const gateway = new SshGateway(initial.transport, initial.runtime, () => reconnecting ??= (async () => {
            const next = await this.setup(host); const previous = state.transport; state.transport = next.transport; await previous.close(); return next;
          })().finally(() => { reconnecting = undefined; }));
          state.gateway = gateway;
          try { if (this.closed) throw new Error("The local app is shutting down"); this.sessions.set(id, state); this.directoryCache = undefined; return state; }
          catch (error) { await gateway.close(); await state.transport.close(); throw error; }
        })();
        this.pending.set(id, pending);
        void pending.finally(() => this.pending.delete(id)).catch(() => undefined);
      }
      session = await pending;
    }
    return { url: `/computer/${id}/` };
  }
  /** Install an independent host. The workspace stays private and keeps running. */
  async setupTeamServer(id: string, body: { remotePort?: unknown }) {
    this.assertBrowse(); await this.load();
    if (this.teamRemoving.has(id)) throw new HttpError(409, "Wait for team server deletion to finish");
    if (this.closed) throw new HttpError(503, "The local app is shutting down");
    const host = this.hosts.find((item) => item.id === id);
    if (!host) throw new HttpError(404, "SSH connection not found");
    const workspace = this.sessions.get(id);
    if (!workspace || workspace.gateway.error) throw new HttpError(409, "Connect to this server in SSH connections first");
    const remotePort = body.remotePort ?? 4318;
    if (!Number.isInteger(remotePort) || Number(remotePort) < 1 || Number(remotePort) > 65535) throw new HttpError(400, "Choose a team port from 1 to 65535");
    let pending = this.teamPending.get(id);
    if (!pending) {
      pending = (async () => {
        const initial = await this.setup(host, Number(remotePort));
        const state: Session = { transport: initial.transport, gateway: undefined! };
        state.gateway = new SshGateway(initial.transport, initial.runtime, async () => {
          const next = await this.setup(host, initial.runtime.remotePort ?? Number(remotePort));
          const previous = state.transport; state.transport = next.transport; await previous.close(); return next;
        }, "/api/team-host-runtime");
        try {
          this.assertBrowse();
          if (this.closed || !this.sessions.has(id)) throw new HttpError(409, "SSH disconnected during setup. Reconnect and resume; the team server stays installed.");
          const previous = this.teamSessions.get(id);
          this.teamSessions.set(id, state);
          if (previous) { await previous.gateway.close(); await previous.transport.close(); }
          return { remotePort: initial.runtime.remotePort ?? Number(remotePort), currentVersion: initial.currentVersion };
        } catch (error) { await state.gateway.close(); await state.transport.close(); throw error; }
      })();
      this.teamPending.set(id, pending);
      void pending.finally(() => this.teamPending.delete(id)).catch(() => undefined);
    }
    return pending;
  }
  async teamAutostart(id: string, action: string = "status") {
    if (this.teamRemoving.has(id)) throw new HttpError(409, "Wait for team server deletion to finish");
    this.assertBrowse();
    if (!["status", "enable", "disable"].includes(action)) throw new HttpError(400, "Choose status, enable or disable for automatic startup");
    if (this.teamPending.has(id)) throw new HttpError(409, "Wait for team server setup to finish");
    const session = this.teamSessions.get(id);
    if (!session || !this.sessions.has(id)) throw new HttpError(409, "Open team server setup on this SSH connection first");
    const code = await readFile(new URL("./team-autostart.mjs", import.meta.url), "utf8");
    const text = await session.transport.bootstrap(code + "\nawait main();", JSON.stringify({ action }));
    const result = JSON.parse(text.split(/\r?\n/).find((line) => line.startsWith("CODEFLOW_AUTOSTART "))?.slice(19) ?? "null");
    if (!result || typeof result.enabled !== "boolean" || typeof result.supported !== "boolean" || typeof result.message !== "string") throw new HttpError(502, "The server returned an invalid automatic startup status");
    return result;
  }
  async teamServerStatus(id: string) {
    this.assertBrowse(); await this.load();
    if (!this.hosts.some(host => host.id === id)) throw new HttpError(404, "SSH connection not found");
    const session = this.sessions.get(id);
    if (!session || session.gateway.error) throw new HttpError(409, "Connect to this server to check its team server");
    const code = await readFile(new URL("./team-status.mjs", import.meta.url), "utf8");
    const text = await session.transport.bootstrap(code, "");
    const result = JSON.parse(text.split(/\r?\n/).find(line => line.startsWith("CODEFLOW_TEAM_STATUS "))?.slice(21) ?? "null");
    if (!result || !["running", "not-installed", "unavailable"].includes(result.state)) throw new HttpError(502, "Could not read the team server status");
    return result;
  }
  async removeTeamServer(id: string) {
    this.assertBrowse(); await this.load();
    if (this.teamPending.has(id)) throw new HttpError(409, "Wait for team server setup to finish");
    const session = this.sessions.get(id);
    if (!session || session.gateway.error) throw new HttpError(409, "Connect to this server before deleting its team server");
    if (this.teamRemoving.has(id)) throw new HttpError(409, "Team server deletion is already in progress");
    this.teamRemoving.add(id);
    try {
      const code = await readFile(new URL("./team-remove.mjs", import.meta.url), "utf8");
      const text = await session.transport.bootstrap(code + '\nconsole.log("CODEFLOW_TEAM_REMOVED " + JSON.stringify(await removeTeamServer()));', "");
      const result = JSON.parse(text.split(/\r?\n/).find(line => line.startsWith("CODEFLOW_TEAM_REMOVED "))?.slice(22) ?? "null");
      if (!result?.removed) throw new HttpError(502, "Team server deletion could not be verified");
      const previous = this.teamSessions.get(id); this.teamSessions.delete(id);
      if (previous) { await previous.gateway.close(); await previous.transport.close(); }
      return { removed: true };
    } finally { this.teamRemoving.delete(id); }
  }
  async forwardTeamServer(id: string, req: IncomingMessage, res: ServerResponse, path: string, origin: string) {
    this.assertBrowse();
    if (this.teamRemoving.has(id)) throw new HttpError(409, "Wait for team server deletion to finish");
    // This is an owner-only setup surface, not a general remote command proxy.
    const url = new URL(path, origin), method = req.method ?? "GET";
    const allowed = method === "GET" && /^\/api\/(projects|accounts(?:\/invitations)?|remote|team\/board)$/.test(url.pathname)
      || method === "POST" && /^\/api\/(projects|accounts(?:\/invitations)?|remote(?:\/tls)?)$/.test(url.pathname)
      || method === "DELETE" && /^\/api\/accounts\/invitations\/i-[a-f0-9-]{36}$/.test(url.pathname)
      || method === "PUT" && /^\/api\/(accounts\/[^/]+|team\/profile|team\/projects\/[^/]+\/repositories)$/.test(url.pathname);
    if (!allowed) throw new HttpError(404, "Unknown team server setup operation");
    if (url.pathname.startsWith("/api/team/")) url.searchParams.set("teamConnection", "local");
    const session = this.teamSessions.get(id);
    if (!session || !this.sessions.has(id)) throw new HttpError(409, "Open team server setup on this SSH connection first");
    // The local policy gate already parsed JSON; forward its cached value rather than an exhausted stream.
    const body = method === "GET" || method === "DELETE" ? undefined : await readJson(req, 192 * 1024);
    return session.gateway.forward(req, res, url.pathname + url.search, origin, body);
  }
  async stopTeamServer(id: string) {
    this.assertBrowse();
    if (this.teamPending.has(id)) throw new HttpError(409, "Wait for team server setup to finish");
    const session = this.teamSessions.get(id);
    if (!session) throw new HttpError(409, "Open team server setup before stopping it");
    await session.gateway.json("/api/team-host-runtime/stop", "POST", {});
    this.teamSessions.delete(id); await session.gateway.close(); await session.transport.close();
  }
  private directoryPending?: Promise<ComputerProjects[]>;
  private directoryCache?: { until: number; value: ComputerProjects[] };
  private assertBrowse() {
    if (this.options.canBrowse && !this.options.canBrowse()) throw new HttpError(409, "Filesystem restrictions pause connected projects");
  }
  async projectDirectory(): Promise<ComputerProjects[]> {
    this.assertBrowse();
    await this.load();
    let remotes = this.directoryCache && this.directoryCache.until > Date.now() ? this.directoryCache.value : undefined;
    if (!remotes) {
      this.directoryPending ??= Promise.all([...this.sessions].map(async ([id, session]): Promise<ComputerProjects> => {
        const host = this.hosts.find((host) => host.id === id)!;
        try {
          const rows = await session.gateway.json("/api/projects", "GET", undefined, 5000);
          if (!Array.isArray(rows) || rows.some((p) => !p || typeof p.id !== "string" || typeof p.name !== "string")) throw new Error("Invalid project list");
          return { id, name: host.name, projects: rows.map(({ id, name }) => ({ id, name })) };
        } catch { return { id, name: host.name, projects: [], error: "Connection unavailable" }; }
      })).finally(() => { this.directoryPending = undefined; });
      remotes = await this.directoryPending;
      this.directoryCache = { until: Date.now() + 5000, value: remotes };
    }
    this.assertBrowse();
    // Re-check live sessions after the async reads: removed hosts must not reappear.
    return [{ id: "local", name: "This computer", projects: (this.options.localProjects?.() ?? []).map(({ id, name }) => ({ id, name })) }, ...remotes.filter((host) => this.sessions.has(host.id)).sort((a, b) => this.hosts.findIndex((host) => host.id === a.id) - this.hosts.findIndex((host) => host.id === b.id))];
  }
  async context(id: string) {
    this.assertBrowse(); await this.load();
    const host = this.hosts.find((host) => host.id === id);
    if (!host) throw new HttpError(404, "Computer not found");
    const session = this.sessions.get(id);
    return { kind: "ssh" as const, id, name: host.name, connected: !!session, error: session?.gateway.error };
  }
  async forward(id: string, req: IncomingMessage, res: ServerResponse, path: string, origin: string) {
    this.assertBrowse();
    const session = this.sessions.get(id);
    if (!session) throw new HttpError(409, "This computer is disconnected. Reconnect it in Settings.");
    return session.gateway.forward(req, res, path, origin);
  }
  async disconnect(id: string) {
    await this.teamPending.get(id)?.catch(() => undefined);
    const team = this.teamSessions.get(id); this.teamSessions.delete(id);
    if (team) { await team.gateway.close(); await team.transport.close(); }
    const session = this.sessions.get(id) ?? await this.pending.get(id)?.catch(() => undefined);
    this.sessions.delete(id); this.directoryCache = undefined;
    if (session) { await session.gateway.close(); await session.transport.close(); }
  }
  async remove(id: string) { await this.disconnect(id); await this.change(() => { this.hosts = this.hosts.filter((host) => host.id !== id); }); }
  async stop(id: string) {
    const session = this.sessions.get(id); if (!session) throw new HttpError(409, "Connect to this server before stopping its backend");
    await session.gateway.json("/api/ssh-runtime/stop", "POST", {}); await this.disconnect(id);
  }
  async close() { this.closed = true; await Promise.allSettled([...new Set([...this.sessions.keys(), ...this.pending.keys()])].map((id) => this.disconnect(id))); }
}
