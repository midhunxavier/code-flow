import { request, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { HttpError, readJson, send } from "../http.js";
import { Previews } from "../preview.js";
import type { SshTransport } from "./transport.js";

export interface Runtime { protocol: 1; port: number; token: string; instance: string; version: string; pid: number; remotePort?: number }
export function parseRuntime(text: string): Runtime {
  const raw = JSON.parse(text.split(/\r?\n/).reverse().find((line) => line.startsWith("CODEFLOW_SSH_READY "))?.slice(19) ?? "null");
  if (raw?.protocol !== 1 || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535 || !/^[a-f0-9]{64}$/.test(raw.token) || !/^[a-f0-9]{32}$/.test(raw.instance) || !/^[a-f0-9]{64}$/.test(raw.version)) throw new Error("The SSH host returned an invalid backend handshake");
  if (raw.remotePort !== undefined && (!Number.isInteger(raw.remotePort) || raw.remotePort < 1 || raw.remotePort > 65535)) throw new Error("The SSH host returned an invalid team port");
  return raw;
}
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

/** Routes an authenticated local app request through SSH. Never serves remote HTML as app UI. */
export class SshGateway {
  private streams = new Set<Duplex>();
  private origins = new Set<string>();
  private closed = false;
  private previews: Previews;
  private restoring?: Promise<void>;
  error?: string;
  private healthCheckedAt = 0;
  private healthSequence = 0;
  private healthPending?: Promise<void>;
  async checkHealth() {
    if (Date.now() - this.healthCheckedAt < 5000) return;
    return this.healthPending ??= this.json(this.probe, "GET", undefined, 3000).then(() => {}, () => {}).finally(() => { this.healthPending = undefined; });
  }
  private health(transport: SshTransport, sequence: number, error?: string) {
    if (this.closed || transport !== this.transport || sequence !== this.healthSequence) return;
    this.error = error; this.healthCheckedAt = Date.now();
  }
  constructor(private transport: SshTransport, private runtime: Runtime, private reconnect: () => Promise<{ transport: SshTransport; runtime: Runtime }>, private readonly probe = "/api/ssh-runtime") {
    this.previews = new Previews(() => [...this.origins], () => [this.runtime.port], (target) => this.open(target.port, target.hostname));
  }
  private open(port: number, hostname?: string) {
    const stream = this.transport.open(port, hostname); this.streams.add(stream);
    stream.once("close", () => this.streams.delete(stream));
    return stream;
  }
  restore(): Promise<void> {
    return this.restoring ??= (async () => {
      const next = await this.reconnect();
      if (this.closed) { await next.transport.close(); throw new HttpError(410, "This computer was disconnected"); }
      this.previews.closeAll(); for (const stream of this.streams) stream.destroy();
      this.transport = next.transport; this.runtime = next.runtime; this.error = undefined;
    })().finally(() => { this.restoring = undefined; });
  }
  async ensureConnected() {
    if (this.restoring) return this.restoring;
    const probedTransport = this.transport;
    try { await this.json(this.probe); }
    catch {
      // A delayed probe of an old transport must not tear down its replacement.
      if (this.transport === probedTransport) await this.restore();
    }
    if (this.restoring) await this.restoring;
  }
  async forward(req: IncomingMessage, res: ServerResponse, path: string, origin: string, body?: object) {
    if (this.restoring) await this.restoring;
    if (this.closed) throw new HttpError(410, "This computer was disconnected");
    if (!path.startsWith("/api/")) throw new HttpError(404, "Unknown remote operation");
    this.origins.add(origin);
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");
    if (new URL(path, origin).pathname === "/api/preview" && req.method === "POST") {
      const lease = await this.json("/api/ssh-runtime/preview", "POST", await readJson(req, 8192));
      return send(res, 200, await this.previews.show(String(lease.url), new URL(origin).host));
    }
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) if (value !== undefined && !HOP.has(key) && !["cookie", "authorization", "host", "origin", "referer", "forwarded"].includes(key) && !key.startsWith("x-forwarded-")) headers[key] = value;
    headers.host = `127.0.0.1:${this.runtime.port}`;
    headers.authorization = `Bearer ${this.runtime.token}`;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) { headers["content-type"] = "application/json"; headers["content-length"] = String(Buffer.byteLength(payload)); }
    if (req.headers.origin) headers.origin = `http://${headers.host}`;
    const transport = this.transport, sequence = ++this.healthSequence;
    const up = request({ host: "127.0.0.1", port: this.runtime.port, method: req.method, path, headers, createConnection: () => this.open(this.runtime.port) }, (incoming) => {
      this.health(transport, sequence);
      const out: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined && !HOP.has(key) && !["set-cookie", "clear-site-data", "location", "content-security-policy", "content-security-policy-report-only"].includes(key)) out[key] = value;
      if (incoming.headers.location) { incoming.destroy(); send(res, 502, { error: "Unexpected remote API redirect" }); return; }
      // A compromised remote must not turn a download/API response into active content
      // on the owner's app origin. Previews keep their separate, isolated origins.
      out["content-security-policy"] = "sandbox allow-downloads; default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
      out["x-content-type-options"] = "nosniff";
      out["referrer-policy"] = "no-referrer";
      out["cache-control"] = "no-store";
      res.writeHead(incoming.statusCode ?? 502, out); incoming.pipe(res);
      incoming.on("error", () => res.destroy());
    });
    up.on("error", () => {
      if (res.destroyed) return; // Navigation cancelled this request; the transport may still be healthy.
      const error = "Connection interrupted. Reconnect this computer; your work remains there.";
      this.health(transport, sequence, error);
      if (res.headersSent) res.destroy(); else send(res, 502, { error });
    });
    res.on("close", () => { if (!res.writableFinished) up.destroy(); });
    if (payload !== undefined) up.end(payload); else req.pipe(up);
  }
  json(path: string, method = "GET", body?: unknown, timeoutMs = 30_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const transport = this.transport, sequence = ++this.healthSequence;
      const failed = (error: Error) => { this.health(transport, sequence, "Connection interrupted. Reconnect this computer; your work remains there."); reject(error); };
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request({ host: "127.0.0.1", port: this.runtime.port, method, path, headers: { authorization: `Bearer ${this.runtime.token}`, ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) }, createConnection: () => this.open(this.runtime.port) }, (res) => {
        this.health(transport, sequence);
        let text = ""; res.setEncoding("utf8");
        res.on("data", (data) => { text += data; if (text.length > 2 * 1024 * 1024) req.destroy(new Error("Remote response exceeds its limit")); });
        res.on("error", failed);
        res.on("end", () => { try { const value = JSON.parse(text); if ((res.statusCode ?? 500) >= 400) reject(new HttpError(res.statusCode!, value.error ?? "Remote request failed")); else resolve(value); } catch (error) { reject(error); } });
      });
      const timer = setTimeout(() => req.destroy(new Error("Remote request timed out")), timeoutMs);
      req.on("close", () => clearTimeout(timer)); req.on("error", failed); req.end(payload);
    });
  }
  async close() {
    this.closed = true;
    this.previews.closeAll(); for (const stream of this.streams) stream.destroy();
  }
}
