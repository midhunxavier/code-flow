import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const jsonBodies = new WeakMap<IncomingMessage, { size: number; value: Promise<any> }>();
export async function readJson(req: IncomingMessage, maxBytes = 40 * 1024 * 1024, options: { timeoutMs?: number } = {}): Promise<any> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("A positive request body limit is required");
  const cached = jsonBodies.get(req); if (cached) { const value = await cached.value; if (cached.size > maxBytes) throw new HttpError(413, "Request body exceeds this operation's limit"); return value; }
  const record = { size: 0, value: undefined as unknown as Promise<any> }; record.value = parseJson(req, maxBytes, options, (size) => { record.size = size; }); jsonBodies.set(req, record); return record.value;
}
async function parseJson(req: IncomingMessage, maxBytes: number, options: { timeoutMs?: number }, recordSize: (size: number) => void): Promise<any> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("A positive request body limit is required");
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "Expected application/json");
  const declared = req.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new HttpError(413, "Request body exceeds this operation's limit");
  const chunks: Buffer[] = [];
  let size = 0;
  const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => req.destroy(new HttpError(408, "Request body timed out")), options.timeoutMs);
  timeout?.unref();
  try {
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > maxBytes) throw new HttpError(413, "Request body exceeds this operation's limit");
      chunks.push(chunk);
    }
  } finally { recordSize(size); clearTimeout(timeout); }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
    return value;
  } catch { throw new HttpError(400, "Invalid JSON object"); }
}

let loginBodies = 0;
/** Admission precedes body buffering and password hashing; slow anonymous uploads cannot grow without bound. */
export async function readLoginJson(req: IncomingMessage): Promise<any> {
  if (loginBodies >= 4) throw new HttpError(429, "Sign-in is busy; try again shortly");
  loginBodies++;
  try { return await readJson(req, 8 * 1024, { timeoutMs: 10_000 }); }
  finally { loginBodies--; }
}
