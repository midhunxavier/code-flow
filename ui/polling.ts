/** Completion-based polling: hidden tabs pause and slow requests never overlap. */
export function pollVisible(action: () => unknown, intervalMs: number, onError: (error: unknown) => void = () => {}) {
  let stopped = false, running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    clearTimeout(timer);
    if (stopped || running || document.hidden) return;
    running = true;
    try { await action(); } catch (error) { onError(error); }
    finally {
      running = false;
      if (!stopped && intervalMs > 0 && !document.hidden) timer = setTimeout(() => void tick(), intervalMs);
    }
  };
  const visibility = () => { clearTimeout(timer); if (!document.hidden) void tick(); };
  document.addEventListener("visibilitychange", visibility);
  void tick();
  return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
}
