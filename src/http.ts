import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export async function readJson(req: IncomingMessage): Promise<any> {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "Expected application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 40 * 1024 * 1024) throw new HttpError(413, "Request too large: attached files must total under 25 MB");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
    return value;
  } catch { throw new HttpError(400, "Invalid JSON object"); }
}
