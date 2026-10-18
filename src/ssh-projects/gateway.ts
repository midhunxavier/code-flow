import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { HttpError, readJson, send } from "../http.js";
import { Previews } from "../preview.js";
import type { SshTransport } from "./transport.js";

export interface Runtime { protocol: 1; port: number; token: string; instance: string; version: string; pid: number }
export function parseRuntime(text: string): Runtime {
  const raw = JSON.parse(text.split(/\r?\n/).reverse().find((line) => line.startsWith("CODEFLOW_SSH_READY "))?.slice(19) ?? "null");
  if (raw?.protocol !== 1 || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535 || !/^[a-f0-9]{64}$/.test(raw.token) || !/^[a-f0-9]{32}$/.test(raw.instance) || !/^[a-f0-9]{64}$/.test(raw.version)) throw new Error("The SSH host returned an invalid backend handshake");
  return raw;
}
const equals = (a: string, b: string) => /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

/** Separate browser origin for each SSH workspace; local cookies and credentials never reach it. */
export class SshGateway {
  private server?: Server;
  private sockets = new Set<Socket>();
  private streams = new Set<Duplex>();
  private cookie = `codeflow_ssh_${randomBytes(12).toString("hex")}`;
  private session = randomBytes(32).toString("hex");
  private tickets = new Map<string, number>();
  private origin = "";
  private closed = false;
  private previews: Previews;
  error?: string;
  constructor(readonly workspaceId: string, readonly name: string, readonly returnUrl: string, private transport: SshTransport, private runtime: Runtime, private reconnect: () => Promise<{ transport: SshTransport; runtime: Runtime }>) {
    this.previews = new Previews(() => [this.origin], () => [this.runtime.port], (target) => this.open(target.port, target.hostname));
  }
  private open(port: number, hostname?: string) {
    const stream = this.transport.open(port, hostname); this.streams.add(stream);
    stream.once("close", () => this.streams.delete(stream));
    return stream;
  }
  async listen() {
    this.server = createServer({ maxHeaderSize: 1024 * 1024 }, (req, res) => {
      void this.handle(req, res).catch((error) => { if (res.headersSent) res.destroy(); else send(res, error instanceof HttpError ? error.status : 502, { error: error.message }); });
    });
    this.server.on("connection", (socket) => { this.sockets.add(socket); socket.on("close", () => this.sockets.delete(socket)); });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(0, "127.0.0.1", resolve); });
    this.origin = `http://${new URL(this.returnUrl).hostname === "localhost" ? "localhost" : "127.0.0.1"}:${(this.server.address() as AddressInfo).port}`;
  }
  link() {
    for (const [key, expiry] of this.tickets) if (expiry < Date.now()) this.tickets.delete(key);
    if (this.tickets.size >= 32) this.tickets.delete(this.tickets.keys().next().value!);
    const ticket = randomBytes(32).toString("hex"); this.tickets.set(ticket, Date.now() + 60_000);
    return `${this.origin}/?sshTicket=${ticket}`;
  }
  private authorized(req: IncomingMessage) {
    return String(req.headers.cookie ?? "").split(";").some((part) => { const [key, ...value] = part.trim().split("="); return key === this.cookie && equals(value.join("="), this.session); });
  }
  private restoring?: Promise<void>;
  restore(): Promise<void> {
    return this.restoring ??= (async () => {
      const next = await this.reconnect();
      if (this.closed) { await next.transport.close(); throw new HttpError(410, "This SSH workspace was disconnected"); }
      this.previews.closeAll(); for (const stream of this.streams) stream.destroy();
      this.transport = next.transport; this.runtime = next.runtime; this.error = undefined;
    })().finally(() => { this.restoring = undefined; });
  }
  async ensureConnected() {
    try { await this.json("/api/ssh-runtime"); }
    catch { await this.restore(); }
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("referrer-policy", "no-referrer"); res.setHeader("cache-control", "no-store");
    if (req.headers.host !== new URL(this.origin).host) throw new HttpError(403, "Bad Host header");
    const url = new URL(req.url ?? "/", this.origin);
    const ticket = url.searchParams.get("sshTicket");
    if (req.method === "GET" && url.pathname === "/" && ticket) {
      const expiry = this.tickets.get(ticket) ?? 0; this.tickets.delete(ticket);
      if (expiry < Date.now()) throw new HttpError(401, "This SSH link expired. Open the connection again from the local app.");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'", "set-cookie": `${this.cookie}=${this.session}; HttpOnly; SameSite=Strict; Path=/` });
      // A same-site document navigation sends Strict cookies even when the launch was cross-site.
      res.end('<!doctype html><title>Opening SSH workspace</title><p><a href="/">Open workspace</a></p><script>location.replace("/")</script>'); return;
    }
    if (req.headers.origin && req.headers.origin !== this.origin || req.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "Cross-origin request refused");
    if (!this.authorized(req)) throw new HttpError(401, "Open this SSH workspace from the local app's SSH connections.");
    if (url.pathname === "/api/ssh-context" && req.method === "GET") return send(res, 200, { kind: "ssh", name: this.name, returnUrl: this.returnUrl, error: this.error });
    if (url.pathname === "/api/ssh-reconnect" && req.method === "POST") {
      await this.restore();
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/preview" && req.method === "POST") {
      // Require the remote backend's filesystem-policy check before opening any remote port.
      const body = await readJson(req, 8192);
      const lease = await this.json("/api/ssh-runtime/preview", "POST", body);
      return send(res, 200, await this.previews.show(String(lease.url), new URL(this.origin).host));
    }
    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      res.setHeader("set-cookie", `${this.cookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`); return send(res, 200, { signedOut: true });
    }
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) if (value !== undefined && !HOP.has(key) && !["cookie", "authorization", "host", "origin", "referer", "forwarded"].includes(key) && !key.startsWith("x-forwarded-")) headers[key] = value;
    headers.host = `127.0.0.1:${this.runtime.port}`;
    headers.authorization = `Bearer ${this.runtime.token}`;
    if (url.pathname === "/") { headers["accept-encoding"] = "identity"; delete headers["if-none-match"]; delete headers["if-modified-since"]; }
    if (req.headers.origin) headers.origin = `http://${headers.host}`;
    const up = request({ host: "127.0.0.1", port: this.runtime.port, method: req.method, path: req.url, headers, createConnection: () => this.open(this.runtime.port) }, (incoming) => {
      this.error = undefined;
      const out: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined && !HOP.has(key) && !["set-cookie", "clear-site-data", "location"].includes(key)) out[key] = value;
      const location = incoming.headers.location;
      if (location) {
        const next = new URL(location, `http://${headers.host}`);
        if (next.origin !== `http://${headers.host}`) { incoming.destroy(); send(res, 502, { error: "Unexpected remote backend redirect" }); return; }
        next.searchParams.delete("token"); out.location = `${next.pathname}${next.search}${next.hash}`;
      }
      out["referrer-policy"] = "no-referrer";
      if (url.pathname === "/" && req.method === "GET" && String(incoming.headers["content-type"]).includes("text/html")) {
        // Establish the storage namespace before the application imports initialize UI state.
        // Reusing an ephemeral gateway port must never select another server's saved folder.
        let page = ""; incoming.setEncoding("utf8");
        incoming.on("data", (chunk) => { page += chunk; if (page.length > 8 * 1024 * 1024) incoming.destroy(new Error("Remote UI exceeds its limit")); });
        incoming.on("end", () => {
          const html = page.replace(/<script\b/, `<script>window.__CODEFLOW_WORKSPACE=${JSON.stringify(this.workspaceId)};</script><script`);
          delete out["content-length"]; delete out.etag; out["cache-control"] = "no-store";
          res.writeHead(incoming.statusCode ?? 502, out); res.end(html);
        });
      } else { res.writeHead(incoming.statusCode ?? 502, out); incoming.pipe(res); }
      incoming.on("error", () => res.destroy());
    });
    up.on("error", () => {
      this.error = "The SSH connection was interrupted. Reconnect to restore the workspace; check the run before repeating an action.";
      if (res.headersSent) res.destroy();
      else if (url.pathname === "/" && req.method === "GET") {
        res.writeHead(502, { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY", "cache-control": "no-store" });
        res.end(`<!doctype html><title>SSH connection interrupted</title><h1>SSH connection interrupted</h1><p>Your work remains on the server. Reconnect to check its state.</p><button id="retry">Reconnect</button> <a href="${this.returnUrl}">Back to this computer</a><p id="error"></p><script>document.getElementById("retry").onclick=async function(){this.disabled=true;try{const r=await fetch("/api/ssh-reconnect",{method:"POST"});const b=await r.json();if(!r.ok)throw Error(b.error);location.reload()}catch(e){document.getElementById("error").textContent=e.message;this.disabled=false}}</script>`);
      } else send(res, 502, { error: this.error });
    });
    res.on("close", () => { if (!res.writableFinished) up.destroy(); });
    req.pipe(up);
  }
  json(path: string, method = "GET", body?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request({ host: "127.0.0.1", port: this.runtime.port, method, path, headers: { authorization: `Bearer ${this.runtime.token}`, ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) }, createConnection: () => this.open(this.runtime.port) }, (res) => {
        let text = ""; res.setEncoding("utf8");
        res.on("data", (data) => { text += data; if (text.length > 2 * 1024 * 1024) req.destroy(new Error("Remote response exceeds its limit")); });
        res.on("error", reject);
        res.on("end", () => { try { const value = JSON.parse(text); if ((res.statusCode ?? 500) >= 400) reject(new HttpError(res.statusCode!, value.error ?? "Remote request failed")); else resolve(value); } catch (error) { reject(error); } });
      });
      const timer = setTimeout(() => req.destroy(new Error("Remote request timed out")), 30_000);
      req.on("close", () => clearTimeout(timer)); req.on("error", reject); req.end(payload);
    });
  }
  async close() {
    this.closed = true;
    this.tickets.clear(); this.session = randomBytes(32).toString("hex");
    this.previews.closeAll(); for (const stream of this.streams) stream.destroy();
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server ? this.server.close(() => resolve()) : resolve());
  }
}
