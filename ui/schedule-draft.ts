import { canonicalTimeZone, validateSchedule, type Schedule } from "../src/schedule-rules.js";

/** This browser's time zone, by its current IANA name. */
export const localTimezone = () => {
  try { return canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"); } catch { return "UTC"; }
};

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** A schedule being edited, as its fields hold it: an empty zone or interval stays empty. */
export interface ScheduleDraft {
  mode: "off" | "daily" | "every";
  at: string;
  /** Empty: the server's local time. */
  timezone: string;
  days: number[];
  every: string;
}

/**
 * The fields for a saved schedule. One saved without a time zone runs in the server's local
 * time, and keeps doing so: its zone stays empty instead of becoming this browser's. Switching
 * a schedule without a time of day to one starts in this browser's zone.
 */
export function scheduleDraft(schedule: Schedule | undefined, zone = localTimezone()): ScheduleDraft {
  if (schedule && "at" in schedule) return { mode: "daily", at: schedule.at, timezone: schedule.timezone ?? "", days: schedule.days ?? ALL_DAYS, every: "60" };
  return { mode: schedule ? "every" : "off", at: "07:00", timezone: zone, days: ALL_DAYS, every: schedule ? String(schedule.every) : "60" };
}

/** What the fields would save (the server checks it again). */
export function draftSchedule(draft: ScheduleDraft): Schedule | undefined {
  if (draft.mode === "off") return undefined;
  if (draft.mode === "every") return { every: Number(draft.every) };
  const timezone = draft.timezone.trim();
  return { at: draft.at, days: draft.days.length === 7 ? undefined : [...draft.days].sort(), ...(timezone ? { timezone } : {}) };
}

/** Why the fields can't be saved, with the server's own words; undefined when they can. */
export function draftProblem(draft: ScheduleDraft, zoneRequired = false): string | undefined {
  if (draft.mode === "every" && !draft.every.trim()) return "Enter the minutes between runs";
  if (draft.mode === "daily" && zoneRequired && !draft.timezone.trim()) return "Choose a time zone, such as Europe/Stockholm";
  try { validateSchedule(draftSchedule(draft)); return undefined; } catch (err) { return (err as Error).message; }
}

const saved = (schedule?: Schedule) => {
  try { return JSON.stringify(validateSchedule(schedule) ?? null); } catch { return JSON.stringify(schedule ?? null); }
};
/** The same schedule once saved: zone names, day order and "every day" compared as the server stores them. */
export const sameSchedule = (a?: Schedule, b?: Schedule) => saved(a) === saved(b);

/**
 * When a run is next, with its date and zone: a time of day in its own zone (as the schedule
 * reads), anything else in this browser's. A run a week away mustn't read as today.
 */
export function formatNextRun(at: number, schedule?: Schedule, now = Date.now(), locales: Intl.LocalesArgument = []): string {
  const zone = schedule && "at" in schedule ? schedule.timezone : undefined;
  const format = (timeZone?: string) => {
    const year = (t: number) => new Intl.DateTimeFormat("en", { timeZone, year: "numeric" }).format(t);
    return new Date(at).toLocaleString(locales, { timeZone, weekday: "short", month: "short", day: "numeric", ...(year(at) !== year(now) ? { year: "numeric" } : {}), hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  };
  try { return format(zone); } catch { return format(); }
}
