const state = { shellReadyMs: 0, longTasks: 0, longTaskMs: 0, longestTaskMs: 0 };
export const browserPerformance = () => ({ ...state });
/** Navigation-relative timing includes downloading and parsing the initial chunks. */
export function shellReady() { state.shellReadyMs = performance.now(); }
if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) { state.longTasks++; state.longTaskMs += entry.duration; state.longestTaskMs = Math.max(state.longestTaskMs, entry.duration); }
  });
  observer.observe({ type: "longtask", buffered: true });
}
