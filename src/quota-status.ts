/** Provider quota evidence shared by Auto routing and its status UI. */
export interface ProviderQuota { status: string; windows: Record<string, { utilization?: number; resetsAt?: number }>; at: number }
const NEARLY_FULL = 0.9;
const LIMITED_FOR_MS = 60 * 60_000;
/** A CLI that failed for being signed out is passed over this long; then it's tried again (you may have signed in). */
const SIGNED_OUT_FOR_MS = 15 * 60_000;

/** Why an agent shouldn't get new work right now, or undefined if it has room. */
export function quotaReason(q: ProviderQuota | undefined, now = Date.now()): string | undefined {
  if (!q) return undefined;
  if (q.status === "signed_out") return now - q.at < SIGNED_OUT_FOR_MS ? "isn't signed in" : undefined;
  const windows = Object.entries(q.windows);
  const live = windows.filter(([, w]) => !w.resetsAt || w.resetsAt > now);
  if (q.status === "limited" || q.status === "rejected") {
    const resets = windows.map(([, w]) => w.resetsAt).filter((t): t is number => !!t);
    // With reset times known, the limit lasts until the last one; without, an hour.
    if (resets.length ? Math.max(...resets) > now : now - q.at < LIMITED_FOR_MS) return "hit its usage limit";
  }
  for (const [name, w] of live) {
    if ((w.utilization ?? 0) >= NEARLY_FULL) return `is at ${Math.round((w.utilization ?? 0) * 100)}% of its ${name.replace(/_/g, "-")} limit`;
  }
  return undefined;
}
