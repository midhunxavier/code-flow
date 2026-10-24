/** Incremental SSE parsing with bounded buffers, including UTF-8 split across reads. */
export async function readInferenceStream(response: Response, onDelta: (text: string) => void): Promise<unknown> {
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || response.statusText); }
  if (!response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body) throw new Error("The server did not return an inference stream");
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true }); let buffer = "", bytes = 0, result: unknown, terminal = false;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength; if (bytes > 600000) throw new Error("Inference stream exceeded its response limit");
      buffer += decoder.decode(next.value, { stream: true });
      for (let end; (end = buffer.indexOf("\n\n")) >= 0;) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2); if (terminal) throw new Error("Inference continued after its final result");
        let type = "", data = "";
        for (const line of block.split("\n")) { if (line.startsWith("event: ")) type = line.slice(7); else if (line.startsWith("data: ")) data += line.slice(6); }
        if (!data) continue; const event = JSON.parse(data);
        if (type === "delta" && typeof event.text === "string") onDelta(event.text);
        else if (type === "done") { result = event; terminal = true; }
        else if (type === "error") throw new Error(typeof event.error === "string" ? event.error : "Inference failed");
        else if (type !== "meta" && type !== "heartbeat") throw new Error("Invalid inference event");
      }
      if (buffer.length > 300000) throw new Error("Inference event exceeded its size limit");
    }
    buffer += decoder.decode();
    if (!terminal || buffer.trim()) throw new Error("Inference stream disconnected before a final result was confirmed");
    return result;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
