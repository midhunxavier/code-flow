import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { handleMlApi } from "../src/ml/api.js";
import { MlError } from "../src/ml/model.js";
import type { MlService } from "../src/ml/service.js";
import { readInferenceStream } from "../ui/ml/inference-stream.js";
const event = (type: string, value: unknown) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
function response(text: string, size = 7) {
  const bytes = new TextEncoder().encode(text); let offset = 0;
  return new Response(new ReadableStream({ pull(controller) { if (offset >= bytes.length) controller.close(); else { controller.enqueue(bytes.slice(offset, offset + size)); offset += size; } } }), { headers: { "content-type": "text/event-stream" } });
}
test("inference parser preserves fragmented UTF-8 and deltas before the final result", async () => {
  const deltas: string[] = [], result = { result: { text: "Hej 🌍 日本" }, versionId: "pinned-version" };
  assert.deepEqual(await readInferenceStream(response(event("meta", { versionId: result.versionId }) + event("delta", { text: "Hej 🌍 " }) + event("heartbeat", {}) + event("delta", { text: "日本" }) + event("done", result), 1), text => deltas.push(text)), result);
  assert.equal(deltas.join(""), result.result.text);
});
test("inference parser rejects truncation, invalid events, oversized data and late failures", async () => {
  for (const content of [event("delta", { text: "partial" }), event("done", {}) + "data: incomplete", event("done", {}) + event("delta", { text: "late" }), event("delta", { text: 1 }), "x".repeat(300001)]) await assert.rejects(readInferenceStream(response(content, 64000), () => {}));
  await assert.rejects(readInferenceStream(response(event("delta", { text: "partial" }) + event("error", { error: "Memory limit exceeded" })), () => {}), /Memory limit/);
  await assert.rejects(readInferenceStream(response(event("heartbeat", {}).repeat(40000), 64000), () => {}), /response limit/);
});
async function endpoint(predict: MlService["deployments"]["predict"]) {
  const service = { deployments: { predict } } as MlService;
  const server = createServer((req, res) => { const url = new URL(req.url!, "http://localhost"); void handleMlApi(req, res, url, url.pathname.slice(5).split("/"), service).catch(error => { if (!res.destroyed) { res.writeHead(error.status ?? 500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: error.message })); } }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/ml/deployments/fixture`;
  return { server, post: (path: string, signal?: AbortSignal) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: '{"prompt":"Hello"}', signal }) };
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
test("HTTP streaming flushes deltas before completion and returns preflight failures as JSON", async () => {
  let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
  const e = await endpoint(async (_id, _input, options) => { await options?.onEvent?.({ type: "delta", text: "first" }); await gate; return { versionId: "selected" } as any; });
  try {
    const res = await e.post("/stream"), reader = res.body!.getReader();
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
    finish(); let tail = ""; for (;;) { const chunk = await reader.read(); if (chunk.done) break; tail += new TextDecoder().decode(chunk.value); } assert.match(tail, /event: done/); assert.match(tail, /selected/);
  } finally { finish(); await close(e.server); }
  const failed = await endpoint(async () => { throw new MlError("Deployment stopped", 409); });
  try { const res = await failed.post("/stream"); assert.equal(res.status, 409); assert.match(res.headers.get("content-type")!, /json/); assert.equal((await res.json()).error, "Deployment stopped"); } finally { await close(failed.server); }
});
test("HTTP errors after a delta remain SSE errors rather than a successful result", async () => {
  const e = await endpoint(async (_id, _input, options) => { await options?.onEvent?.({ type: "delta", text: "partial" }); throw new Error("Worker disconnected"); });
  try { const deltas: string[] = []; await assert.rejects(readInferenceStream(await e.post("/stream"), text => deltas.push(text)), /Worker disconnected/); assert.deepEqual(deltas, ["partial"]); } finally { await close(e.server); }
});
test("disconnecting either JSON prediction or SSE cancels the admitted persistent request", { timeout: 10000 }, async () => {
  for (const path of ["/predict", "/stream"]) {
    let admitted!: () => void, cancelled!: () => void;
    const started = new Promise<void>(resolve => { admitted = resolve; }), stopped = new Promise<void>(resolve => { cancelled = resolve; });
    const e = await endpoint(async (_id, _input, options) => {
      admitted(); await new Promise<void>(resolve => options!.signal!.addEventListener("abort", () => { cancelled(); resolve(); }, { once: true })); throw new Error("Cancelled");
    });
    try {
      const abort = new AbortController(), request = e.post(path, abort.signal).catch(() => undefined);
      await started; abort.abort(); await stopped; await request;
    } finally { await close(e.server); }
  }
});
