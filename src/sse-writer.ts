import type { ServerResponse } from "node:http";

export const streamHealth = { connections: 0, queuedBytes: 0, peakQueuedBytes: 0, slowDisconnects: 0, sentBytes: 0 };

/** Live producers never wait for a browser. Only a bounded queue waits for drain. */
export function createSseWriter(res: ServerResponse, options: { maxBytes?: number; stallMs?: number } = {}) {
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  let queue: string[] = [], bytes = 0, blocked = false, closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  streamHealth.connections++;
  const discard = () => { streamHealth.queuedBytes -= bytes; bytes = 0; queue = []; };
  const close = () => {
    if (closed) return;
    closed = true; clearTimeout(timer); discard(); streamHealth.connections--;
    res.off("drain", drain);
  };
  const disconnect = () => { streamHealth.slowDisconnects++; close(); res.destroy(); };
  const send = (chunk: string) => {
    streamHealth.sentBytes += Buffer.byteLength(chunk);
    if (!res.write(chunk)) {
      blocked = true;
      timer = setTimeout(disconnect, options.stallMs ?? 30_000);
      timer.unref?.();
    }
  };
  const drain = () => {
    clearTimeout(timer); blocked = false;
    while (queue.length && !blocked && !closed) {
      const chunk = queue.shift()!, size = Buffer.byteLength(chunk);
      bytes -= size; streamHealth.queuedBytes -= size; send(chunk);
    }
  };
  res.on("drain", drain); res.once("close", close);
  return {
    write(chunk: string) {
      if (closed || res.destroyed || res.writableEnded) return;
      const size = Buffer.byteLength(chunk);
      if (bytes + res.writableLength + size > maxBytes) { disconnect(); return; }
      if (!blocked) { send(chunk); return; }
      queue.push(chunk); bytes += size; streamHealth.queuedBytes += size;
      streamHealth.peakQueuedBytes = Math.max(streamHealth.peakQueuedBytes, streamHealth.queuedBytes);
    },
    get closed() { return closed; },
  };
}
