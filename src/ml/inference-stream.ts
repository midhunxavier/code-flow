import type { ServerResponse } from "node:http";
import type { MlService } from "./service.js";
/** SSE is owner-authenticated by the normal API route. Slow/disconnected readers cancel compute. */
export async function streamInference(res: ServerResponse, service: MlService, deploymentId: string, input: unknown) {
  const abort = new AbortController();
  const closed = () => { if (!res.writableEnded) abort.abort(); }; res.on("close", closed);
  async function write(type: string, value: unknown) {
    if (abort.signal.aborted || res.destroyed) throw new Error("Inference client disconnected");
    if (!res.headersSent) { res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no", "connection": "keep-alive" }); res.flushHeaders(); }
    const data = `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
    if (Buffer.byteLength(data) > 260000) throw new Error("Inference event exceeds its limit");
    if (!res.write(data)) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { abort.abort(); fail(); }, 5000);
      const cleanup = () => { clearTimeout(timer); res.off("drain", drained); abort.signal.removeEventListener("abort", fail); };
      const drained = () => { cleanup(); resolve(); }, fail = () => { cleanup(); reject(new Error("Inference client stopped receiving data")); };
      res.once("drain", drained); abort.signal.addEventListener("abort", fail, { once: true }); if (abort.signal.aborted) fail();
    });
  }
  try {
    const result = await service.deployments.predict(deploymentId, input, { signal: abort.signal, onEvent: async event => write(event.type, event) });
    await write("done", result); res.end();
  } catch (error) {
    if (!res.headersSent) throw error;
    if (!abort.signal.aborted && !res.destroyed) { await write("error", { error: (error as Error).message.slice(0, 1000) }).catch(() => {}); res.end(); }
  } finally { abort.abort(); res.off("close", closed); }
}
