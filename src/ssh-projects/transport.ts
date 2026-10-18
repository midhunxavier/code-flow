import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Duplex } from "node:stream";

export const validSshHost = (host: unknown): host is string => typeof host === "string" && /^[A-Za-z0-9][A-Za-z0-9._@-]{0,199}$/.test(host);
export interface SshOptions { port?: number; identityFile?: string }
export function validSshOptions(options: { port?: unknown; identityFile?: unknown }): boolean {
  return (options.port === undefined || Number.isInteger(options.port) && Number(options.port) >= 1 && Number(options.port) <= 65535)
    && (options.identityFile === undefined || typeof options.identityFile === "string" && options.identityFile.length <= 4096
      && (isAbsolute(options.identityFile) || options.identityFile.startsWith("~/")) && !/[\x00-\x1f\x7f%]/.test(options.identityFile));
}
export const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const OPTIONS = ["-T", "-a", "-k", "-o", "GSSAPIDelegateCredentials=no", "-o", "SendEnv=-*", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "PermitLocalCommand=no", "-o", "RemoteCommand=none", "-o", "ClearAllForwardings=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];

/** Fixed commands and TCP streams over OpenSSH. Credentials and host policy stay with OpenSSH. */
export class SshTransport {
  private directory = "";
  private children = new Set<ChildProcess>();
  private closed = false;
  constructor(readonly host: string, private readonly binary = "ssh", private readonly options: SshOptions = {}) {
    if (!validSshHost(host)) throw new Error("Enter an SSH host alias or user@hostname");
    if (!validSshOptions(options)) throw new Error("Use a port from 1 to 65535 and an absolute or ~/ SSH key path without control characters or % tokens");
  }
  async init() { this.directory = await mkdtemp(join(tmpdir(), "cf-ssh-")); }
  private start(args: string[], command?: string) {
    if (this.closed) throw new Error("SSH connection is closed");
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "HOME", "USER", "LOGNAME", "SSH_AUTH_SOCK", "SYSTEMROOT", "SystemRoot", "TMPDIR"]) if (process.env[name]) env[name] = process.env[name];
    const connection = [...(this.options.port ? ["-p", String(this.options.port)] : []), ...(this.options.identityFile ? ["-i", this.options.identityFile] : [])];
    const child = spawn(this.binary, [...OPTIONS, ...connection, "-o", "ControlMaster=auto", "-o", "ControlPersist=60", "-o", `ControlPath=${join(this.directory, "socket")}`, ...args, this.host, ...(command ? [command] : [])], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.children.add(child); child.once("close", () => this.children.delete(child));
    return child;
  }
  async bootstrap(code: string, payload: string): Promise<string> {
    // Only fixed application code is executed; the host is a validated separate argv value.
    const command = `exec sh -c ${quote(`exec "\${SHELL:-/bin/sh}" -lc ${quote(`exec node --input-type=module -e ${quote(code)}`)}`)}`;
    const child = this.start([], command);
    return new Promise((resolve, reject) => {
      let stdout = "", stderr = "", settled = false;
      const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(stdout); };
      const timer = setTimeout(() => { child.kill(); finish(new Error("SSH setup timed out. Check the server's SSH login, Node.js and ~/.codeflow/ssh-host/host.log.")); }, 120_000);
      child.stdout!.on("data", (data) => { stdout += data; if (stdout.length > 64 * 1024) { child.kill(); finish(new Error("SSH setup produced too much output")); } });
      child.stderr!.on("data", (data) => { stderr = (stderr + data).slice(-8192); });
      child.once("error", finish);
      child.stdin!.on("error", () => undefined);
      child.once("close", (code) => finish(code === 0 ? undefined : new Error(`SSH setup failed: ${stderr.trim() || `exit ${code}`}. Verify ${this.host} with the same port and key in an SSH terminal first.`)));
      child.stdin!.end(payload);
    });
  }
  open(port: number, hostname = "127.0.0.1"): Duplex {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid remote port");
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname)) throw new Error("SSH forwards only remote loopback addresses");
    const host = hostname.includes(":") ? "[::1]" : hostname;
    const child = this.start(["-W", `${host}:${port}`]);
    const stream = Duplex.from({ readable: child.stdout!, writable: child.stdin! });
    // HTTP removes its listeners after a response; later disconnects still close both pipes.
    stream.on("error", () => undefined);
    child.stdin!.on("error", () => undefined);
    child.stdout!.on("error", () => undefined);
    let stderr = "";
    child.stderr!.on("data", (data) => { stderr = (stderr + data).slice(-2048); });
    child.once("error", (error) => stream.destroy(error));
    child.once("close", (code) => { if (code) stream.destroy(new Error(`SSH connection failed: ${stderr.trim() || `exit ${code}`}`)); });
    stream.once("close", () => { child.kill(); });
    return stream;
  }
  async close() {
    if (this.closed) return;
    // Stop only our SSH control master, never the detached remote backend or its work.
    const child = this.start(["-O", "exit"]);
    child.on("error", () => undefined); child.stdout!.resume(); child.stderr!.resume(); child.stdin!.end();
    await new Promise<void>((resolve) => { const timer = setTimeout(() => { child.kill(); resolve(); }, 2000); child.once("close", () => { clearTimeout(timer); resolve(); }); });
    this.closed = true;
    for (const process of this.children) process.kill();
    await rm(this.directory, { recursive: true, force: true });
  }
}
