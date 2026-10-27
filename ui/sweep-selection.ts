import type { SweepItem } from "./types.js";

/** Kept in step with the API's per-request run cap. */
export const MAX_SWEEP = 25;
export const pickableSweepItem = (item: SweepItem) => !item.manual && !item.blockedReason && !item.existingRun && !!item.source && !!item.task;
export const defaultSweepPicks = (items: SweepItem[]) => new Set(items.filter(item => item.selected && pickableSweepItem(item)).slice(0, MAX_SWEEP).map(item => item.key));
export function selectSweepItems(picked: Set<string>, shown: SweepItem[], on: boolean): Set<string> {
  const next = new Set(picked);
  for (const item of shown) if (pickableSweepItem(item)) {
    if (!on) next.delete(item.key);
    else if (next.size < MAX_SWEEP) next.add(item.key);
  }
  return next;
}
export function matchesSweepFilter(item: SweepItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  // A severity query matches the badge, not a different severity's explanatory note.
  if (item.severity && ["critical", "high", "error", "medium", "warning", "low", "note", "unknown"].includes(q)) return item.severity?.toLowerCase() === q;
  return !q || [item.ref, item.title, item.detail, item.note, item.severity, ...(item.labels ?? [])].filter(Boolean).join(" ").toLowerCase().includes(q);
}
