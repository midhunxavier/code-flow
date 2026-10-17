import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { logWarn } from "./log.js";

/**
 * The side panel's Browser shows a local app (a dev server, an app a run started) through a
 * preview proxy. Each app gets a port of its own on 127.0.0.1: a different origin from code-flow,
 * so the app's scripts can never use code-flow's session. Its address uses the host name
 * code-flow's page was opened with (localhost or 127.0.0.1), so the app is same-site with that
 * page and its own login cookies work in the frame. Cookies ignore ports, so code-flow's own
 * cookies reach the proxy too: they're never passed on to the app, and the app can't set them.
 * The proxy forwards everything to the app (WebSockets too, for hot reload) and adds a small
 * script to its pages, the overlay, which the panel talks to with postMessage: pick an element
 * or draw a box to comment on, see console errors and failed requests, try style changes. In
 * place of the headers that stop a page from being shown in a frame, it sends a policy that lets
 * only code-flow's own page (and the app itself) frame it.
 *
 * Only local addresses are proxied, and only requests addressed to the proxy itself are served
 * (the Host check), so a web page can't use it to reach a dev server by DNS rebinding.
 */

export interface PreviewTarget {
  /** As you typed it: localhost, 127.0.0.1 or [::1]. */
  hostname: string;
  port: number;
}

interface Preview {
  port: number;
  server: Server;
  usedAt: number;
  /** Both ends of each upgraded connection (hot reload): closing the server leaves them open. */
  sockets: Set<Duplex>;
}

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const MAX_PREVIEWS = 20;
const OVERLAY_PATH = "/__codeflow/overlay.js";
const overlaySource = readFileSync(new URL("./preview-overlay.js", import.meta.url), "utf8");
/**
 * Headers that keep a page out of a frame, or keep the overlay script from running. The app's
 * Content-Security-Policy isn't among them: it's rewritten (framedPolicy), so it still protects the page.
 */
const DROPPED = new Set(["content-security-policy-report-only", "x-frame-options", "cross-origin-opener-policy", "cross-origin-embedder-policy"]);
/** code-flow's own cookies (the session and phone cookies in src/server.ts). */
const OWN_COOKIE = /^codeflow_/;
/** Pages the app sends compressed although it was asked not to: decompressed so the overlay can be added. */
const DECODE: Record<string, (body: Buffer) => Buffer> = { gzip: gunzipSync, "x-gzip": gunzipSync, deflate: inflateSync, br: brotliDecompressSync };

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
  private readonly open = new Map<string, Preview>();
  /** The origins code-flow's own page can have: the overlay takes commands only from them, and only they may frame a preview. */
  constructor(private readonly parents: () => string[], private readonly ownPorts: () => number[]) {}

  /**
   * The preview for a local app: its address on the proxy. The same app keeps its port. `host`
   * is the Host code-flow's page was asked for with; the preview uses the same host name.
   */
  async show(address: string, host = ""): Promise<{ url: string; origin: string }> {
    const target = previewTarget(address);
    if (!target) throw new Error("The preview shows apps on this computer: an http://localhost:<port> address");
    if (this.ownPorts().includes(target.port)) throw new Error("That's code-flow itself");
    const key = `${target.hostname}:${target.port}`;
    let entry = this.open.get(key);
    if (!entry) {
      if (this.open.size >= MAX_PREVIEWS) this.closeOldest();
      const sockets = new Set<Duplex>();
      const server = this.proxy(target, sockets);
      const port = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
      });
      entry = { port, server, usedAt: Date.now(), sockets };
      this.open.set(key, entry);
    }
    entry.usedAt = Date.now();
    // localhost and 127.0.0.1 are different sites: on code-flow's own host name, the app's cookies aren't third-party.
    const hostname = host.split(":")[0] === "localhost" ? "localhost" : "127.0.0.1";
    const origin = `http://${hostname}:${entry.port}`;
    return { url: `${origin}${target.path}`, origin };
  }

  closeAll() {
    for (const preview of this.open.values()) stop(preview);
    this.open.clear();
  }

  private closeOldest() {
    const [key, oldest] = [...this.open.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0]!;
    stop(oldest);
    this.open.delete(key);
  }

  private proxy(target: PreviewTarget, sockets: Set<Duplex>): Server {
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
      // Pages are asked for uncompressed, so the overlay can be added. Without the header, any encoding would do.
      headers["accept-encoding"] = "identity";
      const upstream = request({ host: upstreamHost, port: target.port, method: req.method, path: req.url, headers }, (up) => {
        up.on("error", () => res.destroy());
        const nonce = randomBytes(16).toString("base64");
        const out: OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(up.headers)) {
          if (value === undefined || DROPPED.has(name)) continue;
          if (name === "location" && typeof value === "string") out[name] = value.replace(targetOrigin, `http://${own}`);
          else if (name === "set-cookie") {
            const cookies = [value].flat().filter((c) => !OWN_COOKIE.test(c.trimStart()));
            if (cookies.length) out[name] = cookies;
          } else out[name] = value;
        }
        const policy = framedPolicy(up.headers["content-security-policy"], this.parents(), nonce);
        out["content-security-policy"] = policy;
        const encoding = String(up.headers["content-encoding"] ?? "identity").trim().toLowerCase();
        const decode = encoding === "identity" ? (body: Buffer) => body : DECODE[encoding];
        const html = String(up.headers["content-type"] ?? "").includes("text/html") && req.method !== "HEAD";
        if (!html || !decode) {
          res.writeHead(up.statusCode ?? 502, out);
          up.pipe(res);
          return;
        }
        const chunks: Buffer[] = [];
        up.on("data", (c: Buffer) => chunks.push(c));
        up.on("end", () => {
          const body = Buffer.concat(chunks);
          let page: string;
          try {
            page = injectOverlay(decode(body).toString("utf8"), policy.includes(`'nonce-${nonce}'`) ? nonce : undefined);
          } catch {
            // Not in the encoding it named: the page as it came, without the overlay.
            res.writeHead(up.statusCode ?? 502, out);
            return res.end(body);
          }
          delete out["content-length"];
          delete out["content-encoding"];
          delete out["etag"];
          res.writeHead(up.statusCode ?? 502, { ...out, "cache-control": "no-store" });
          res.end(page);
        });
      });
      upstream.on("error", (err) => refuse(res, 502, `The app at ${targetOrigin} didn't answer (${(err as NodeJS.ErrnoException).code ?? err.message}). Is it running?`));
      // The browser left (a reload, another page): the app's side closes too, or an event stream would stay open forever.
      res.on("close", () => {
        if (!res.writableFinished) upstream.destroy();
      });
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
      for (const side of [socket, up]) {
        sockets.add(side);
        side.on("close", () => sockets.delete(side));
      }
    });
    server.on("clientError", (_err, socket) => socket.destroy());
    server.on("error", (err) => logWarn(`Preview of ${targetOrigin}: ${err.message}`));
    return server;
  }
}

/** Closes a preview's proxy and every connection it has open, so the app's side of each closes too. */
function stop(preview: Preview) {
  preview.server.close();
  preview.server.closeAllConnections();
  for (const socket of preview.sockets) socket.destroy();
}

/** The proxy's own host:port as the request named it, or undefined when it named something else. */
function ownHost(req: IncomingMessage, server: Server): string | undefined {
  const port = (server.address() as AddressInfo | null)?.port;
  const host = req.headers.host ?? "";
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` ? host : undefined;
}

/** The request's headers as the app expects them: its own host, its own origin where the page's was, and none of code-flow's cookies. */
function forwardHeaders(req: IncomingMessage, target: PreviewTarget, targetOrigin: string, own: string): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = { ...req.headers, host: `${target.hostname}:${target.port}` };
  if (typeof headers.origin === "string") headers.origin = targetOrigin;
  if (typeof headers.referer === "string") headers.referer = headers.referer.replace(`http://${own}`, targetOrigin);
  const cookies = String(req.headers.cookie ?? "")
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c && !OWN_COOKIE.test(c));
  if (cookies.length) headers.cookie = cookies.join("; ");
  else delete headers.cookie;
  return headers;
}

/**
 * The app's Content-Security-Policy as code-flow's frame needs it, and no looser: framing only by
 * code-flow's own page and the app itself (in place of the app's frame-ancestors and
 * X-Frame-Options), the overlay script allowed, and data: images for its snapshots. The rest of
 * the app's policy stays. Each policy in the header is enforced on its own, so each is changed.
 */
export function framedPolicy(appPolicy: string | string[] | undefined, parents: string[], nonce: string): string {
  const policies = [appPolicy ?? []]
    .flat()
    .flatMap((header) => header.split(","))
    .map((policy) => framedDirectives(policy, nonce))
    .filter(Boolean);
  return [...policies, `frame-ancestors 'self' ${parents.join(" ")}`].join(", ");
}

function framedDirectives(policy: string, nonce: string): string {
  const directives = new Map<string, string[]>();
  for (const directive of policy.split(";")) {
    const [name = "", ...sources] = directive.trim().split(/\s+/);
    // Browsers use the first of a repeated directive.
    if (name && !directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), sources);
  }
  directives.delete("frame-ancestors");
  const fallback = directives.get("default-src");
  // Where scripts fall back to default-src, they get a directive of their own, so nothing else is loosened.
  const script = directives.has("script-src-elem") ? "script-src-elem" : "script-src";
  const scripts = directives.get(script) ?? fallback;
  if (scripts) {
    // A nonce turns 'unsafe-inline' off, so a policy that relies on it allows the overlay as 'self' instead.
    const inline = scripts.some((s) => s.toLowerCase() === "'unsafe-inline'") && !scripts.some((s) => /^'(nonce-|sha(256|384|512)-|strict-dynamic')/i.test(s));
    directives.set(script, [...scripts, inline ? "'self'" : `'nonce-${nonce}'`]);
  }
  const images = directives.get("img-src") ?? fallback;
  if (images) directives.set("img-src", [...images, "data:"]);
  return [...directives].map(([name, sources]) => [name, ...sources].join(" ")).join("; ");
}

/**
 * What can come before the first thing in <head>, all optional: a byte order mark, white space,
 * comments, the doctype, and the <html> and <head> tags. Nothing may go before the doctype (the
 * page would be laid out in quirks mode), and a <head> tag after anything else is inside
 * something (a comment, a script) or ignored by browsers.
 */
const LEAD = /^\uFEFF?(?:\s|<!--[\s\S]*?-->|<!doctype[^>]*>|<html(?:[\s/][^>]*)?>|<head(?:[\s/][^>]*)?>)*/i;

/** The overlay script, first thing in <head> (where the browser puts it, when the page leaves the tag out). */
export function injectOverlay(page: string, nonce?: string): string {
  const tag = `<script src="${OVERLAY_PATH}"${nonce ? ` nonce="${nonce}"` : ""}></script>`;
  const at = LEAD.exec(page)?.[0].length ?? 0;
  return page.slice(0, at) + tag + page.slice(at);
}

function refuse(res: ServerResponse, status: number, message: string) {
  if (res.headersSent || res.destroyed) return res.destroy();
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
}
