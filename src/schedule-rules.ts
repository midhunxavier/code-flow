/**
 * What a schedule may be, checked the same way by the server (saving it) and the app (before
 * it's sent, so Save can be off while it can't be saved). No Node APIs: the app imports this.
 */

export type Schedule = { every: number } | { at: string; days?: number[]; timezone?: string };

export const MIN_EVERY_MINUTES = 5;
/** A week: the longest an interval schedule waits between runs. */
export const MAX_EVERY_MINUTES = 7 * 24 * 60;
export const TIME_ZONE_PROBLEM = "Choose a valid IANA time zone, such as Europe/Stockholm";

/**
 * ICU, and so Intl, still names some zones by their old IANA names: "Asia/Kolkata" resolves to
 * "Asia/Calcutta" even when typed exactly. Both name the same zone, so firing times are the same;
 * schedules are saved and shown with the current name.
 */
const CURRENT_ZONE_NAMES = new Map(Object.entries({
  "Africa/Asmera": "Africa/Asmara",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Coral_Harbour": "America/Atikokan",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Godthab": "America/Nuuk",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Louisville": "America/Kentucky/Louisville",
  "America/Mendoza": "America/Argentina/Mendoza",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Europe/Kiev": "Europe/Kyiv",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
}));

/** A zone's current IANA name, its letter case fixed ("asia/kolkata" → "Asia/Kolkata"). Throws for an unknown zone. */
export function canonicalTimeZone(input: string): string {
  const resolved = new Intl.DateTimeFormat("en", { timeZone: input.trim() }).resolvedOptions().timeZone;
  return CURRENT_ZONE_NAMES.get(resolved) ?? resolved;
}

/** The schedule as it's saved, or undefined for none; throws with the reason it can't be saved. */
export function validateSchedule(input: unknown): Schedule | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  if (raw.every !== undefined) {
    if (raw.at !== undefined) throw new Error("Choose either every (minutes) or at (HH:MM), not both");
    if (raw.days !== undefined || raw.timezone !== undefined) throw new Error("Days and a time zone apply only to a schedule at a time of day");
    const every = typeof raw.every === "string" && raw.every.trim() ? Number(raw.every) : raw.every;
    if (typeof every !== "number" || !Number.isInteger(every)) throw new Error("Choose a whole number of minutes between runs");
    if (every < MIN_EVERY_MINUTES) throw new Error(`Runs must be at least ${MIN_EVERY_MINUTES} minutes apart`);
    if (every > MAX_EVERY_MINUTES) throw new Error(`Runs can be at most ${MAX_EVERY_MINUTES} minutes (7 days) apart`);
    return { every };
  }
  if (typeof raw.at === "string") {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.at)) throw new Error('Time must look like "07:30"');
    if (raw.days !== undefined && (!Array.isArray(raw.days) || raw.days.length > 7 || !raw.days.length || raw.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) throw new Error("Choose at least one valid day of the week");
    const days = Array.isArray(raw.days) ? [...new Set<number>(raw.days)].sort() : undefined;
    let timezone: string | undefined;
    if (raw.timezone !== undefined) {
      if (typeof raw.timezone !== "string" || !raw.timezone.trim() || raw.timezone.length > 100) throw new Error(TIME_ZONE_PROBLEM);
      try { timezone = canonicalTimeZone(raw.timezone); }
      catch { throw new Error(TIME_ZONE_PROBLEM); }
    }
    return { at: raw.at, days: days?.length && days.length < 7 ? days : undefined, ...(timezone ? { timezone } : {}) };
  }
  throw new Error("A schedule needs every (minutes) or at (HH:MM)");
}
