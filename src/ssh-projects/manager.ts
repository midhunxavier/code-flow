import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEFLOW_HOME } from "../config.js";
import { HttpError } from "../http.js";
import { sshAliases } from "./config.js";
import { SshGateway, parseRuntime } from "./gateway.js";
import { SshTransport, validSshHost } from "./transport.js";

interface Host { id: string; name: string; sshHost: string }
interface Session { transport: SshTransport; gateway: SshGateway }
export class SshProjects {
  private hosts: Host[] = [];
  private loaded?: Promise<void>;
  private writes: Promise<unknown> = Promise.resolve();
  private sessions = new Map<string, Session>();
  private pending = new Map<string, Promise<Session>>();
  private closed = false;
  private file: string;
  constructor(private readonly options: { home?: string; returnUrl: string; sshBinary?: string; packagePath?: string; configPath?: string }) { this.file = join(options.home ?? CODEFLOW_HOME, "ssh-hosts.json"); }
  private load() {
    return this.loaded ??= readFile(this.file, "utf8").then((text) => {
      const raw = JSON.parse(text);
      if (!raw || raw.version !== 1 || !Array.isArray(raw.hosts) || raw.hosts.length > 32 || raw.hosts.some((host: Host) => !host || typeof host !== "object" || !/^[a-f0-9]{16}$/.test(host.id) || !validSshHost(host.sshHost) || typeof host.name !== "string" || !host.name || host.name.length > 80) || new Set(raw.hosts.map((host: Host) => host.id)).size !== raw.hosts.length) throw new Error("Repair the SSH connections file before continuing");
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
  async add(body: { name?: unknown; sshHost?: unknown }) {
    if (!validSshHost(body.sshHost)) throw new HttpError(400, "Enter an SSH alias or user@hostname. Configure custom ports and keys in ~/.ssh/config.");
    const name = typeof body.name === "string" ? body.name.trim() : body.sshHost;
    if (!name || name.length > 80) throw new HttpError(400, "Name the server using at most 80 characters");
    const host: Host = { id: randomBytes(8).toString("hex"), name, sshHost: body.sshHost };
    await this.change(() => { if (this.hosts.length >= 32) throw new HttpError(409, "Remove an unused SSH connection first (32 maximum)"); if (this.hosts.some((item) => item.sshHost === host.sshHost)) throw new HttpError(409, "This SSH host is already saved"); this.hosts.push(host); }); return host;
  }
  private async setup(host: Host) {
    const [code, payload] = await Promise.all([readFile(new URL("./bootstrap.mjs", import.meta.url), "utf8"), readFile(this.options.packagePath ?? fileURLToPath(new URL("../../dist/remote-host.json", import.meta.url)), "utf8").catch(() => { throw new Error("Build the SSH host package with npm run build:host, then connect again."); })]);
    if (payload.length > 32 * 1024 * 1024) throw new Error("Remote host package exceeds 32 MiB");
    const transport = new SshTransport(host.sshHost, this.options.sshBinary); await transport.init();
    try { const runtime = parseRuntime(await transport.bootstrap(code, payload)); return { transport, runtime }; }
    catch (error) { await transport.close(); throw error; }
  }
  async connect(id: string, returnUrl = this.options.returnUrl) {
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
          const gateway = new SshGateway(host.id, host.name, returnUrl, initial.transport, initial.runtime, () => reconnecting ??= (async () => {
            const next = await this.setup(host); const previous = state.transport; state.transport = next.transport; await previous.close(); return next;
          })().finally(() => { reconnecting = undefined; }));
          state.gateway = gateway;
          try { await gateway.listen(); if (this.closed) throw new Error("The local app is shutting down"); this.sessions.set(id, state); return state; }
          catch (error) { await gateway.close(); await state.transport.close(); throw error; }
        })();
        this.pending.set(id, pending);
        void pending.finally(() => this.pending.delete(id)).catch(() => undefined);
      }
      session = await pending;
    }
    return { url: session.gateway.link() };
  }
  async disconnect(id: string) {
    const session = this.sessions.get(id) ?? await this.pending.get(id)?.catch(() => undefined);
    this.sessions.delete(id);
    if (session) { await session.gateway.close(); await session.transport.close(); }
  }
  async remove(id: string) { await this.disconnect(id); await this.change(() => { this.hosts = this.hosts.filter((host) => host.id !== id); }); }
  async stop(id: string) {
    const session = this.sessions.get(id); if (!session) throw new HttpError(409, "Connect to this server before stopping its backend");
    await session.gateway.json("/api/ssh-runtime/stop", "POST", {}); await this.disconnect(id);
  }
  async close() { this.closed = true; await Promise.allSettled([...new Set([...this.sessions.keys(), ...this.pending.keys()])].map((id) => this.disconnect(id))); }
}
