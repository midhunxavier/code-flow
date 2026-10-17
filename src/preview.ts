import { readFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { logWarn } from "./log.js";

/**
 * The side panel's Browser shows a local app (a dev server, an app a run started) through a
 * preview proxy. Each app gets a port of its own on 127.0.0.1: a different origin from code-flow,
 * so the app's scripts can never use code-flow's session. The proxy forwards everything to the
 * app (WebSockets too, for hot reload) and adds a small script to its pages, the overlay, which
 * the panel talks to with postMessage: pick an element or draw a box to comment on, see console
 * errors and failed requests, try style changes. It drops the headers that stop a page from being
 * shown in a frame, since showing it in one is the point.
 *
 * Only local addresses are proxied, and only requests addressed to the proxy itself are served
 * (the Host check), so a web page can't use it to reach a dev server by DNS rebinding.
 */

export interface PreviewTarget {
  /** As you typed it: localhost, 127.0.0.1 or [::1]. */
  hostname: string;
  port: number;
}

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const MAX_PREVIEWS = 20;
const OVERLAY_PATH = "/__codeflow/overlay.js";
const overlaySource = readFileSync(new URL("./preview-overlay.js", import.meta.url), "utf8");
/** Headers that keep a page out of a frame, or keep the overlay script from running. */
const DROPPED = new Set(["content-security-policy", "content-security-policy-report-only", "x-frame-options", "cross-origin-opener-policy", "cross-origin-embedder-policy"]);

/** A local http(s) address the preview can show, or undefined. */
export function previewTarget(address: string): (PreviewTarget & { path: string }) | undefined {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" || !LOCAL.has(url.hostname)) return undefined;
  const port = Number(url.port || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return { hostname: url.hostname, port, path: `${url.pathname}${url.search}${url.hash}` };
}

export class Previews {
  private readonly open = new Map<string, { port: number; server: Server; usedAt: number }>();
  /** The origins code-flow's own page can have: the overlay takes commands only from them. */
  constructor(private readonly parents: () => string[], private readonly ownPorts: () => number[]) {}

  /** The preview for a local app: its address on the proxy. The same app keeps its port. */
  async show(address: string): Promise<{ url: string; origin: string }> {
    const target = previewTarget(address);
    if (!target) throw new Error("The preview shows apps on this computer: an http://localhost:<port> address");
    if (this.ownPorts().includes(target.port)) throw new Error("That's code-flow itself");
    const key = `${target.hostname}:${target.port}`;
    let entry = this.open.get(key);
    if (!entry) {
      if (this.open.size >= MAX_PREVIEWS) this.closeOldest();
      const server = this.proxy(target);
      const port = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
      });
      entry = { port, server, usedAt: Date.now() };
      this.open.set(key, entry);
    }
    entry.usedAt = Date.now();
    const origin = `http://127.0.0.1:${entry.port}`;
    return { url: `${origin}${target.path}`, origin };
  }

  closeAll() {
    for (const { server } of this.open.values()) server.close();
    this.open.clear();
  }

  private closeOldest() {
    const [key, oldest] = [...this.open.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0]!;
    oldest.server.close();
    this.open.delete(key);
  }

  private proxy(target: PreviewTarget): Server {
    const upstreamHost = target.hostname.replace(/^\[|\]$/g, "");
    const targetOrigin = `http://${target.hostname}:${target.port}`;
    const server = createServer((req, res) => {
      const own = ownHost(req, server);
      if (!own) return refuse(res, 403, "Bad Host header");
      if (req.url?.startsWith(OVERLAY_PATH)) {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        return res.end(overlaySource.replace("__PARENTS__", JSON.stringify(this.parents())));
      }
      const headers = forwardHeaders(req, target, targetOrigin, own);
      // Pages come back uncompressed, so the overlay can be added.
      delete headers["accept-encoding"];
      const upstream = request({ host: upstreamHost, port: target.port, method: req.method, path: req.url, headers }, (up) => {
        const out: OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(up.headers)) {
          if (value === undefined || DROPPED.has(name)) continue;
          out[name] = name === "location" && typeof value === "string" ? value.replace(targetOrigin, `http://${own}`) : value;
        }
        const html = String(up.headers["content-type"] ?? "").includes("text/html") && req.method !== "HEAD";
        if (!html) {
          res.writeHead(up.statusCode ?? 502, out);
          up.pipe(res);
          return;
        }
        const chunks: Buffer[] = [];
        up.on("data", (c: Buffer) => chunks.push(c));
        up.on("end", () => {
          const page = injectOverlay(Buffer.concat(chunks).toString("utf8"));
          delete out["content-length"];
          delete out["content-encoding"];
          delete out["etag"];
          res.writeHead(up.statusCode ?? 502, { ...out, "cache-control": "no-store" });
          res.end(page);
        });
        up.on("error", () => res.destroy());
      });
      upstream.on("error", (err) => refuse(res, 502, `The app at ${targetOrigin} didn't answer (${(err as NodeJS.ErrnoException).code ?? err.message}). Is it running?`));
      req.pipe(upstream);
    });
    // Hot reload and other WebSockets: the handshake goes through with the app's own host and origin, then bytes both ways.
    server.on("upgrade", (req, socket, head) => {
      const own = ownHost(req, server);
      if (!own) return socket.destroy();
      const up = connect(target.port, upstreamHost, () => {
        const headers = forwardHeaders(req, target, targetOrigin, own);
        const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : v === undefined ? [] : [`${k}: ${v}`]))];
        up.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (head.length) up.write(head);
        socket.pipe(up).pipe(socket);
      });
      up.on("error", () => socket.destroy());
      socket.on("error", () => up.destroy());
    });
    server.on("clientError", (_err, socket) => socket.destroy());
    server.on("error", (err) => logWarn(`Preview of ${targetOrigin}: ${err.message}`));
    return server;
  }
}

/** The proxy's own host:port as the request named it, or undefined when it named something else. */
function ownHost(req: IncomingMessage, server: Server): string | undefined {
  const port = (server.address() as AddressInfo | null)?.port;
  const host = req.headers.host ?? "";
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` ? host : undefined;
}

/** The request's headers as the app expects them: its own host, and its own origin where the page's was. */
function forwardHeaders(req: IncomingMessage, target: PreviewTarget, targetOrigin: string, own: string): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = { ...req.headers, host: `${target.hostname}:${target.port}` };
  if (typeof headers.origin === "string") headers.origin = targetOrigin;
  if (typeof headers.referer === "string") headers.referer = headers.referer.replace(`http://${own}`, targetOrigin);
  return headers;
}

/** The overlay script, first thing in <head> (or the page, without one). */
export function injectOverlay(page: string): string {
  const tag = `<script src="${OVERLAY_PATH}"></script>`;
  const head = page.match(/<head[^>]*>/i);
  if (head) return page.replace(head[0], `${head[0]}${tag}`);
  const html = page.match(/<html[^>]*>/i);
  return html ? page.replace(html[0], `${html[0]}${tag}`) : tag + page;
}

function refuse(res: ServerResponse, status: number, message: string) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
}
