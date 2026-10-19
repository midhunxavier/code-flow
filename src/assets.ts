import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gzip, brotliCompress, constants } from "node:zlib";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "./http.js";

const gz = promisify(gzip), br = promisify(brotliCompress);
type Asset = { identity: Buffer; gzip: Buffer; br: Buffer };
const cache = new Map<string, Promise<Asset>>();
export async function sendAsset(directory: string, name: string, req: IncomingMessage, res: ServerResponse) {
  if (!/^[\w-]+-[A-Z0-9]{8}\.(?:js|css)$/.test(name)) throw new HttpError(404, "Asset not found");
  let pending = cache.get(name);
  if (!pending) {
    pending = (async () => { const identity = await readFile(join(directory, name)); const [gzip, brotli] = await Promise.all([gz(identity), br(identity, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })]); return { identity, gzip, br: brotli }; })();
    cache.set(name, pending);
    if (cache.size > 64) cache.delete(cache.keys().next().value!);
    void pending.catch(() => { if (cache.get(name) === pending) cache.delete(name); });
  }
  let asset: Asset; try { asset = await pending; } catch { throw new HttpError(404, "Asset not found; reload the app to update it"); }
  const encodings = String(req.headers["accept-encoding"] ?? "").split(",").map((part) => part.trim().toLowerCase()).filter((part) => !/;\s*q=0(?:\.0*)?$/.test(part)).map((part) => part.split(";")[0]);
  const encoding = encodings.includes("br") ? "br" : encodings.includes("gzip") ? "gzip" : undefined;
  const body = encoding ? asset[encoding] : asset.identity;
  const etag = `"${name}${encoding ? `-${encoding}` : ""}"`;
  const headers = { "content-type": name.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8", "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff", vary: "Accept-Encoding", etag };
  if (req.headers["if-none-match"] === etag) { res.writeHead(304, headers); res.end(); return; }
  res.writeHead(200, { ...headers, "content-length": body.length, ...(encoding ? { "content-encoding": encoding } : {}) }); res.end(body);
}
