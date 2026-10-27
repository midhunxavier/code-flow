/** EventSource hides HTTP refusal bodies; a bounded probe makes those actionable. */
export type SharedStreamState = "connected" | "reconnecting" | "limited";
export const SHARED_EVENTS_RETRY_MS = 30_000;
export function openSharedEvents(path: string, onMessage: (event: MessageEvent) => void, onState?: (state: SharedStreamState, reason?: string) => void): () => void {
  let source: EventSource | undefined, retry: ReturnType<typeof setTimeout> | undefined, probe: AbortController | undefined, closed = false;
  const open = () => {
    if (closed) return;
    source?.close(); probe?.abort();
    const current = source = new EventSource(path);
    current.onopen = () => { if (!closed && source === current) onState?.("connected"); };
    current.onmessage = event => { if (!closed && source === current) onMessage(event); };
    current.onerror = () => {
      if (closed || source !== current) return;
      onState?.("reconnecting");
      if (current.readyState !== EventSource.CLOSED) return;
      clearTimeout(retry); retry = setTimeout(open, SHARED_EVENTS_RETRY_MS);
      probe?.abort(); const controller = probe = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      void fetch(path, { headers: { accept: "text/event-stream" }, signal: controller.signal }).then(async response => {
        if (response.ok) { await response.body?.cancel(); return; }
        const body = await response.json().catch(() => ({}));
        if (!closed && source === current && !controller.signal.aborted) onState?.(response.status === 429 ? "limited" : "reconnecting", typeof body.error === "string" ? body.error : `Live updates are unavailable (HTTP ${response.status}).`);
      }).catch(() => {}).finally(() => { clearTimeout(timeout); controller.abort(); });
    };
  };
  open();
  return () => { closed = true; clearTimeout(retry); probe?.abort(); source?.close(); };
}
