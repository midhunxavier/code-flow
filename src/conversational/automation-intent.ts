import type { Schedule } from "../schedule-rules.js";

/** A conservative UI suggestion. The reviewed setup, never this hint, authorizes future runs. */
export function suggestsSchedule(text: string): boolean {
  if (/^\s*(?:how|why|what|explain|describe|can (?:we|you))\b/i.test(text) || text.trim().endsWith("?")) return false;
  return /\b(?:schedule|every (?:\d+ (?:minutes?|hours?)|day|weekday|week|morning|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|daily|each morning|tomorrow)\b/i.test(text);
}
export function automationTiming(text: string, timezone: string): { timing: "once" | "repeat" | "event"; schedule: Schedule } {
  let at = /\b(?:afternoon)\b/i.test(text) ? "13:00" : /\bevening\b/i.test(text) ? "18:00" : "09:00";
  const time = text.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (time) {
    let hour = Number(time[1]); const minute = Number(time[2] ?? 0), meridian = time[3]?.toLowerCase();
    if (meridian && hour >= 1 && hour <= 12) hour = hour % 12 + (meridian === "pm" ? 12 : 0);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) at = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }
  const interval = text.match(/\bevery\s+(\d+)\s+(minutes?|hours?)\b/i);
  const days = /\bweekdays?\b/i.test(text) ? [1, 2, 3, 4, 5] : ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].flatMap((day, index) => new RegExp(`\\b${day}s?\\b`, "i").test(text) ? [index] : []);
  const every = interval ? Number(interval[1]) * (/hour/i.test(interval[2]!) ? 60 : 1) : 0;
  return { timing: /\bwebhook\b|when .*event/i.test(text) ? "event" : /\btomorrow\b|\bonce\b/i.test(text) ? "once" : "repeat", schedule: every >= 1 && every <= 525600 ? { every } : { at, ...(days.length ? { days } : {}), timezone } };
}
