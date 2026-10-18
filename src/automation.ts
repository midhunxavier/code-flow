import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CODEFLOW_HOME } from "./config.js";
import type { Run, RunManager, RunSummary } from "./engine.js";
import type { SourceInput } from "./github.js";
import { logError, logInfo, logWarn } from "./log.js";
import { readRepoConfig } from "./repo-config.js";
import { findSweepItem, nextSweepItems, sourceKeys, sweepTakes, upgradeLegacyKeys, type SweepKind, type SweepList } from "./sweeps.js";

/**
 * Automations: a saved run (repo, pattern, task, team, settings) that starts on a schedule, from
 * a webhook, or when you press "Run now". Their results wait in the inbox for you to approve,
 * revise or reject — nothing is merged automatically.
 */

export type Schedule = { every: number } | { at: string; days?: number[]; timezone?: string };

export interface Trigger {
  id: string;
  name: string;
  enabled: boolean;
  /** The run to start: the same fields as a run request from the composer. */
  run: Record<string, any> & { repo: string; pattern: string; task: string };
  schedule?: Schedule;
  /** Accept POST /hooks/<id> authenticated with the token (Bearer, or GitHub's signature). */
  webhook: boolean;
  token: string;
  /** Run check and setup commands in a Docker container. */
  isolate: boolean;
  image?: string;
  createdAt: number;
  /** When the schedule fires next. Saved, so a restart keeps it instead of starting the count again. */
  nextAt?: number;
  lastFiredAt?: number;
  lastRunId?: string;
  lastError?: string;
  /**
   * A recurring sweep: each time it fires it lists this kind of work and starts one run per new
   * item (at most `max`), instead of the one saved run.
   */
  sweep?: { kind: SweepKind; max: number };
  /** Items a sweep has started a run for ("issue#12", "dependabot#5"…), so it never starts them twice. */
  handled?: string[];
  /** GitHub's ids of the latest webhook deliveries, so a delivery sent again doesn't start another run. */
  deliveries?: string[];
  /** Webhook events that came in while this automation's run was going; each fires when it ends. */
  queued?: Omit<FireInput, "via">[];
  /** Bounded delivery audit and dead-letter history; contains validated event data only. */
  eventHistory?: AutomationEvent[];
  /** When webhooks started runs, over the last hour (they're capped per hour). */
  webhookStarts?: number[];
}

/** What a webhook or schedule adds to the saved run. */
export interface FireInput {
  via: "schedule" | "webhook" | "manual";
  /** Extra text for the task (e.g. from a webhook payload). */
  details?: string;
  source?: SourceInput;
  /** Internal reference used when draining a queued event. */
  eventId?: string;
}

export interface AutomationEvent {
  id: string;
  at: number;
  updatedAt: number;
  via: FireInput["via"];
  state: "received" | "queued" | "started" | "failed" | "dropped" | "deduplicated" | "skipped";
  input: Omit<FireInput, "via" | "eventId">;
  delivery?: string;
  reason?: string;
  runIds?: string[];
  retries: number;
}
export interface AutomationPreview {
  automation: string;
  ready: boolean;
  busy?: string;
  wouldQueue: boolean;
  nextTimes: number[];
  selected: { key: string; task: string; source?: SourceInput }[];
  skipped: { key: string; reason: string }[];
  warnings: string[];
  permissions: { trust: string; isolate: boolean; image?: string };
  limits: { maxSteps?: number; maxInvocations?: number; maxMinutes?: number; startsPerHour: number; startsUsed: number };
  commands: { setup?: string; check?: string };
}

export interface FireResult {
  run?: Run;
  runs?: Run[];
  skipped?: string;
  /** The event waits for the running run to end, then fires. */
  queued?: boolean;
}

/** A sweep remembers this many handled items; the oldest are forgotten first. */
const MAX_HANDLED = 2_000;
/** Webhook deliveries remembered per automation, to ignore replays. */
const MAX_DELIVERIES = 500;
/** Webhook events waiting for a run to end, per automation; the oldest are dropped first. */
const MAX_QUEUED = 10;
const MAX_EVENT_HISTORY = 100;
/** Webhook-started runs per hour for an automation that isn't a sweep (a sweep's limit is its `max`). */
const WEBHOOK_RUNS_PER_HOUR = 10;
const HOUR = 3_600_000;
/** A scheduled time missed while code-flow was closed or asleep still fires if it's at most this late. */
export const MISSED_GRACE_MS = HOUR;

const FILE = join(CODEFLOW_HOME, "triggers.json");
const MIN_EVERY_MINUTES = 5;
const SWEEP_KINDS: SweepKind[] = ["issues", "dependabot", "alerts"];

export function validateSchedule(input: unknown): Schedule | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  if (raw.every !== undefined) {
    const every = Math.round(Number(raw.every));
    if (!Number.isFinite(every) || every < MIN_EVERY_MINUTES) throw new Error(`Repeat at most every ${MIN_EVERY_MINUTES} minutes`);
    return { every: Math.min(every, 7 * 24 * 60) };
  }
  if (typeof raw.at === "string") {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.at)) throw new Error('Time must look like "07:30"');
    if (raw.days !== undefined && (!Array.isArray(raw.days) || raw.days.length > 7 || !raw.days.length || raw.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) throw new Error("Choose at least one valid day of the week");
    const days = Array.isArray(raw.days) ? [...new Set<number>(raw.days)].sort() : undefined;
    let timezone: string | undefined;
    if (raw.timezone !== undefined) {
      if (typeof raw.timezone !== "string" || !raw.timezone.trim() || raw.timezone.length > 100) throw new Error("Choose a valid IANA time zone, such as Europe/Stockholm");
      try { timezone = new Intl.DateTimeFormat("en", { timeZone: raw.timezone.trim() }).resolvedOptions().timeZone; }
      catch { throw new Error("Choose a valid IANA time zone, such as Europe/Stockholm"); }
    }
    return { at: raw.at, days: days?.length && days.length < 7 ? days : undefined, ...(timezone ? { timezone } : {}) };
  }
  throw new Error("A schedule needs every (minutes) or at (HH:MM)");
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();
function zonedParts(at: number, timezone: string) {
  let format = zoneFormats.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    if (zoneFormats.size >= 64) zoneFormats.clear();
    zoneFormats.set(timezone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(at).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute) };
}
const wallTime = (p: ReturnType<typeof zonedParts>) => Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);

/** Resolve a wall clock time. Repeated times fire once; a DST gap shifts forward by the gap. */
function zonedTime(day: Date, hour: number, minute: number, timezone: string): number | undefined {
  const desired = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute);
  const offsets = new Set([-36, -12, 0, 12, 36].map((h) => {
    const sample = desired + h * HOUR;
    return wallTime(zonedParts(sample, timezone)) - sample;
  }));
  const candidates = [...offsets].map((offset) => desired - offset).sort((a, b) => a - b);
  const exact = candidates.find((at) => wallTime(zonedParts(at, timezone)) === desired);
  if (exact !== undefined) return exact;
  // A whole local date can be skipped by a time zone change. Skip that date, not its weekday policy.
  return candidates.filter((at) => {
    const p = zonedParts(at, timezone);
    return p.year === day.getUTCFullYear() && p.month === day.getUTCMonth() + 1 && p.day === day.getUTCDate() && wallTime(p) > desired;
  }).sort((a, b) => wallTime(zonedParts(a, timezone)) - wallTime(zonedParts(b, timezone)))[0];
}

/** The next instant after `after`, on an allowed day in the schedule's explicit zone. */
export function nextFire(schedule: Schedule, after: number): number {
  if ("every" in schedule) return after + schedule.every * 60_000;
  const [h, m] = schedule.at.split(":").map(Number) as [number, number];
  if (schedule.timezone) {
    const local = zonedParts(after, schedule.timezone);
    const day = new Date(Date.UTC(local.year, local.month - 1, local.day));
    for (let i = 0; i < 14; i++) {
      if (!schedule.days?.length || schedule.days.includes(day.getUTCDay())) {
        const candidate = zonedTime(day, h, m, schedule.timezone);
        if (candidate !== undefined && candidate > after) return candidate;
      }
      day.setUTCDate(day.getUTCDate() + 1);
    }
    throw new Error("Could not find the next scheduled time in this time zone");
  }
  const d = new Date(after);
  // Set again after every day moved: on the day clocks spring forward, 02:30 becomes 03:30, and
  // the next day must still be 02:30.
  const nextDay = () => {
    d.setDate(d.getDate() + 1);
    d.setHours(h, m, 0, 0);
  };
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= after) nextDay();
  for (let i = 0; i < 7 && schedule.days?.length && !schedule.days.includes(d.getDay()); i++) nextDay();
  return d.getTime();
}

/** Preview actual UTC instants; clients format them in both the chosen zone and their local zone. */
export function previewSchedule(input: unknown, after = Date.now(), count = 5): number[] {
  const schedule = validateSchedule(input);
  if (!schedule) return [];
  if (!Number.isFinite(after) || !Number.isInteger(count) || count < 1 || count > 10) throw new Error("Schedule preview needs a valid date and 1–10 occurrences");
  const times: number[] = [];
  for (let i = 0; i < count; i++) { after = nextFire(schedule, after); times.push(after); }
  return times;
}

/**
 * Whether a time the schedule was due at (`due`) should still fire at `now`: code-flow was
 * closed or the computer asleep, and it's at most an hour late, and the day it was due on is
 * one of the schedule's days (Monday's 23:30, fired at 00:10 on Tuesday, still counts).
 * Otherwise that time is skipped.
 */
export function stillDue(schedule: Schedule, due: number, now: number): boolean {
  if (now - due > MISSED_GRACE_MS) return false;
  if ("every" in schedule || !schedule.days?.length) return true;
  const day = schedule.timezone ? zonedParts(due, schedule.timezone) : undefined;
  const weekday = day ? new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay() : new Date(due).getDay();
  return schedule.days.includes(weekday);
}

/**
 * The saved next time, kept across a restart. A time that passed while code-flow was closed
 * stays if it can still fire (see `stillDue`), so the next tick fires it once; otherwise the
 * schedule moves on to its next time.
 */
export function resumeSchedule(schedule: Schedule, saved: number | undefined, now: number): number {
  if (!saved || !Number.isFinite(saved)) return nextFire(schedule, now);
  if (saved <= now) return stillDue(schedule, saved, now) ? saved : nextFire(schedule, now);
  // Further away than the schedule ever waits (the clock moved back): start the count again.
  const longest = "every" in schedule ? schedule.every * 60_000 : 8 * 24 * HOUR;
  return saved - now > longest ? nextFire(schedule, now) : saved;
}

export function describeSchedule(schedule?: Schedule): string {
  if (!schedule) return "only when triggered";
  if ("every" in schedule) return schedule.every % 60 === 0 ? `every ${schedule.every / 60} h` : `every ${schedule.every} min`;
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = schedule.days?.length ? schedule.days.map((d) => names[d]).join(", ") : "every day";
  return `${days} at ${schedule.at}${schedule.timezone ? ` (${schedule.timezone})` : " (server local time)"}`;
}

export class Automations {
  private triggers: Trigger[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private saving: Promise<unknown> = Promise.resolve();
  /**
   * False until triggers.json was read cleanly (or there was none). A file that couldn't be read
   * or set aside is never written over: that would lose every automation and webhook secret.
   */
  private writable = false;
  /** Automations starting their run right now; a second fire meanwhile doesn't start another. */
  private readonly starting = new Set<string>();
  /** Sweeps listing their work right now. */
  private readonly sweeping = new Set<string>();
  /** Per sweep: the items a run is being started for right now. */
  private readonly claimed = new Map<string, Set<string>>();

  constructor(
    private readonly manager: RunManager,
    /** Starts a run exactly like POST /api/runs (validation, Auto roles…). */
    private readonly startRun: (body: Record<string, any>, extra: { trigger: NonNullable<Run["trigger"]> }) => Promise<Run>,
    /** Lists a sweep's items (GitHub issues, Dependabot PRs, alerts) for a recurring sweep. */
    private readonly listSweep?: (repo: string, kind: SweepKind) => Promise<SweepList>,
    private readonly file = FILE,
  ) {}

  /**
   * Read triggers.json. A file that isn't valid JSON, or isn't a list, is moved aside to
   * `triggers.json.corrupt-<time>` (and logged), and code-flow starts with no automations; so
   * is one with entries that can't be used, keeping the usable ones. Saved next times are kept.
   */
  async load(now = Date.now()) {
    this.writable = false;
    this.triggers = [];
    let text: string | undefined;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logError(`Couldn't read ${this.file}; automations are off and it won't be written over until it can be read`, err);
        return;
      }
    }
    const entries: unknown[] = [];
    if (text !== undefined) {
      let parsed: unknown;
      let why = "isn't a list of automations";
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        why = `isn't valid JSON (${(err as Error).message})`;
      }
      if (Array.isArray(parsed)) entries.push(...parsed);
      else if (!(await this.setAside(why))) return;
    }
    let rejected = 0;
    for (const entry of entries) {
      const t = readTrigger(entry);
      if (t) this.triggers.push(t);
      else rejected++;
    }
    if (rejected && !(await this.setAside(`has ${rejected} automation(s) code-flow can't read`))) {
      this.triggers = [];
      return;
    }
    this.writable = true;
    for (const t of this.triggers) t.nextAt = t.enabled && t.schedule ? resumeSchedule(t.schedule, t.nextAt, now) : undefined;
    if (rejected) await this.save();
  }

  /** Move triggers.json aside so it isn't lost when the usable automations are saved. */
  private async setAside(why: string): Promise<boolean> {
    const aside = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      await rename(this.file, aside);
      logError(`${this.file} ${why}: moved it to ${aside}`);
      return true;
    } catch (err) {
      logError(`${this.file} ${why}, and it couldn't be moved aside; automations are off until it's fixed`, err);
      return false;
    }
  }

  list(): Trigger[] {
    return this.triggers.map((t) => ({ ...t }));
  }

  get(id: string): Trigger | undefined {
    return this.triggers.find((t) => t.id === id);
  }

  async create(
    input: Omit<Trigger, "id" | "token" | "createdAt" | "nextAt" | "handled" | "deliveries" | "queued" | "webhookStarts" | "eventHistory"> & { handled?: string[] },
  ): Promise<Trigger> {
    this.requireWritable();
    const trigger: Trigger = { ...input, id: `t-${randomBytes(4).toString("hex")}`, token: randomBytes(24).toString("hex"), createdAt: Date.now() };
    trigger.nextAt = trigger.enabled && trigger.schedule ? nextFire(trigger.schedule, Date.now()) : undefined;
    this.triggers.push(trigger);
    await this.save();
    return { ...trigger };
  }

  async update(id: string, patch: Partial<Pick<Trigger, "name" | "enabled" | "schedule" | "webhook" | "isolate" | "image" | "run">> & { rotateToken?: boolean }) {
    this.requireWritable();
    const t = this.require(id);
    const { rotateToken, ...rest } = patch;
    const timing = JSON.stringify([t.enabled, t.schedule]);
    Object.assign(t, rest);
    if ("schedule" in patch && !patch.schedule) t.schedule = undefined;
    if (rotateToken) t.token = randomBytes(24).toString("hex");
    // Renaming it doesn't move its next time; changing when it runs (or turning it on) does.
    if (JSON.stringify([t.enabled, t.schedule]) !== timing || (t.enabled && t.schedule && !t.nextAt)) {
      t.nextAt = t.enabled && t.schedule ? nextFire(t.schedule, Date.now()) : undefined;
    }
    if (!t.enabled) {
      for (const queued of t.queued ?? []) this.updateEvent(t, queued.eventId, "dropped", "Automation was disabled before this event could run");
      t.queued = undefined;
    }
    await this.save();
    return { ...t };
  }

  /** A sweep started runs for these items itself (when you created it): don't start them again. */
  async markHandled(id: string, keys: string[]) {
    const t = this.require(id);
    t.handled = [...new Set([...(t.handled ?? []), ...keys])].slice(-MAX_HANDLED);
    await this.save();
  }

  async remove(id: string) {
    this.requireWritable();
    this.require(id);
    this.triggers = this.triggers.filter((t) => t.id !== id);
    await this.save();
  }

  start(tickMs = 30_000) {
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref?.();
    // A webhook event that waited for a run fires as soon as that run ends.
    this.unsubscribe = this.manager.subscribeAll((run) => this.runChanged(run));
  }

  /** Stop firing; resolves once the last save is on disk. */
  stop(): Promise<unknown> {
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    return this.saving;
  }

  /**
   * Fire every enabled schedule that is due. A time missed while code-flow was closed or the
   * computer asleep fires once if it's at most an hour late (and on one of its days), and is
   * skipped otherwise; it never fires on a day the schedule leaves out.
   */
  async tick(now = Date.now()) {
    let changed = false;
    for (const t of this.triggers) {
      if (t.queued?.length) void this.drain(t);
      if (!t.enabled || !t.schedule) continue;
      if (!t.nextAt) {
        t.nextAt = nextFire(t.schedule, now);
        changed = true;
        continue;
      }
      if (t.nextAt > now) continue;
      const due = t.nextAt;
      t.nextAt = nextFire(t.schedule, now);
      changed = true;
      if (!stillDue(t.schedule, due, now)) {
        logInfo(`Automation "${t.name}" skipped its ${new Date(due).toLocaleString()} run: code-flow was closed or asleep then`);
        continue;
      }
      // The next time is on disk before the run starts (which takes seconds): stopping code-flow
      // meanwhile mustn't leave the old time saved, to fire again at the next start.
      await this.save();
      await this.fire(t.id, { via: "schedule" }).catch((err) => logWarn(`Automation "${t.name}" couldn't start its scheduled run`, { error: (err as Error).message }));
    }
    if (changed) await this.save();
  }

  /**
   * A webhook call, answered at once: GitHub gives up on a delivery after 10 seconds, and
   * starting a run takes longer than that. The run starts in the background; a failure is
   * recorded on the automation (lastError). A delivery GitHub sends again is ignored.
   */
  accept(id: string, input: Omit<FireInput, "via">, delivery?: string): { accepted: true } | { ignored: string } {
    const t = this.require(id);
    const validated = validateFireInput({ via: "webhook", ...input });
    if (delivery) {
      if (t.deliveries?.includes(delivery)) {
        const duplicate = this.recordEvent(t, validated, delivery);
        this.updateEvent(t, duplicate.id, "deduplicated", `Delivery ${delivery} was already handled`);
        void this.save();
        return { ignored: `Delivery ${delivery} was already handled` };
      }
      t.deliveries = [...(t.deliveries ?? []), delivery].slice(-MAX_DELIVERIES);
      void this.save();
    }
    const event = this.recordEvent(t, validated, delivery);
    void this.fire(id, { ...validated, eventId: event.id }).then(
      (result) => result.skipped && logInfo(`Webhook for automation "${t.name}": ${result.skipped}`),
      (err) => logWarn(`Webhook for automation "${t.name}" couldn't start a run`, { error: (err as Error).message }),
    );
    return { accepted: true };
  }

  /**
   * Start the automation's run. If its previous run is still going (or still starting), a
   * schedule or "Run now" is skipped, so automations never pile up; a webhook event waits and
   * fires once that run ends, so a push made meanwhile isn't lost.
   */
  async fire(id: string, input: FireInput): Promise<FireResult> {
    const t = this.require(id);
    const validated = validateFireInput(input);
    const event = input.eventId ? t.eventHistory?.find((e) => e.id === input.eventId) : undefined;
    const tracked = event ?? this.recordEvent(t, validated);
    try {
      const result = await this.fireOne(t, { ...validated, eventId: tracked.id });
      const runs = result.runs ?? (result.run ? [result.run] : []);
      tracked.runIds = runs.map((run) => run.id);
      const state = result.queued ? "queued" : result.skipped ? /already started \d+ runs from webhooks/.test(result.skipped) ? "dropped" : "skipped" : "started";
      // A newer event can supersede this queued event while its disk save is pending.
      if (!(result.queued && (tracked.state === "deduplicated" || tracked.state === "dropped"))) this.updateEvent(t, tracked.id, state, result.skipped);
      return result;
    } catch (err) {
      this.updateEvent(t, tracked.id, "failed", (err as Error).message);
      throw err;
    } finally { await this.save(); }
  }

  /** Recent queue decisions, start failures and dropped deliveries, newest first. */
  events(id: string): AutomationEvent[] {
    return structuredClone([...(this.require(id).eventHistory ?? [])].reverse());
  }

  async retryEvent(id: string, eventId: string): Promise<FireResult> {
    const t = this.require(id);
    this.requireWritable();
    if (!t.enabled) throw new Error("Enable this automation before retrying an event");
    const event = t.eventHistory?.find((e) => e.id === eventId);
    if (!event) throw new Error("Event is no longer in the bounded history");
    if (event.state !== "failed" && event.state !== "dropped") throw new Error("Only failed or dropped events can be retried");
    // Revalidate the persisted event, then use the normal queue, trust and rate-limit rules.
    const input = validateFireInput({ via: event.via, ...event.input });
    event.retries++;
    this.updateEvent(t, event.id, "received", "Explicit retry requested");
    return this.fire(id, { ...input, eventId: event.id });
  }

  /** List the same candidates and execution settings without claiming items or starting agents. */
  async dryRun(id: string, raw: FireInput = { via: "manual" }): Promise<AutomationPreview> {
    const t = this.require(id);
    const input = validateFireInput(raw);
    const { config, error: configError } = await readRepoConfig(t.run.repo);
    const busy = this.busy(t);
    const warnings: string[] = [];
    if (configError) warnings.push(`Repository configuration: ${configError}`);
    const selected: AutomationPreview["selected"] = [];
    const skipped: AutomationPreview["skipped"] = [];
    if (t.sweep) {
      if (!this.listSweep) throw new Error("Sweeps aren't available here");
      const list = await this.listSweep(t.run.repo, t.sweep.kind);
      warnings.push(...list.notices);
      const handled = new Set(t.handled ?? []);
      upgradeLegacyKeys(list, handled);
      const claims = this.claimed.get(t.id) ?? new Set<string>();
      const items = input.source ? (sweepTakes(t.sweep.kind, input.source) ? [findSweepItem(list, input.source)].filter((i) => i !== undefined) : []) : nextSweepItems(list, new Set([...handled, ...claims]), t.sweep.max);
      for (const item of items) {
        if (item.source && item.task && (!("selected" in item) || item.selected) && (!("manual" in item) || !item.manual) && !sourceKeys(item.source).every((k) => handled.has(k)) && !sourceKeys(item.source).some((k) => claims.has(k))) selected.push({ key: item.key, task: item.task, source: item.source });
      }
      for (const item of list.items.slice(0, 100)) if (!selected.some((chosen) => chosen.key === item.key)) skipped.push({ key: item.key, reason: item.note ?? (item.manual ? "Requires manual action" : handled.has(item.key) ? "Already handled" : "Outside the current selection or limit") });
      if (input.source && !items.length) warnings.push("The event's source is absent from the sweep's current list");
    } else selected.push({ key: "saved-task", task: input.details?.trim() ? `${t.run.task}\n\n## Details from the ${input.via}\n${input.details}` : t.run.task, source: input.source ?? t.run.source });
    const startsPerHour = t.sweep?.max ?? WEBHOOK_RUNS_PER_HOUR;
    const startsUsed = (t.webhookStarts ?? []).filter((at) => Date.now() - at < HOUR).length;
    if (!t.enabled && input.via !== "manual") warnings.push("This automation is disabled");
    if (input.via === "webhook" && startsUsed >= startsPerHour) warnings.push("The webhook run limit has been reached for this hour");
    if (!(t.run.loop?.check ?? config.check) && !t.run.loop?.verification && !t.run.verificationProfile) warnings.push("No independent verification command or profile is configured");
    if (selected.some((item) => item.source)) warnings.push("Source permissions and isolation are rechecked against current GitHub authorship when the run starts");
    const configuredTrust = t.run.trust ?? config.trust ?? "standard";
    const effectiveTrust = configuredTrust === "full" ? "trusted" : configuredTrust;
    return { automation: id, ready: !!selected.length && (t.enabled || input.via === "manual") && !(busy && input.via !== "webhook") && !(input.via === "webhook" && startsUsed >= startsPerHour), busy, wouldQueue: !!busy && input.via === "webhook" && !t.sweep,
      nextTimes: t.schedule ? previewSchedule(t.schedule) : [], selected, skipped, warnings,
      permissions: { trust: effectiveTrust, isolate: t.isolate, ...(t.isolate ? { image: t.image || "node:22" } : {}) },
      limits: { maxSteps: t.run.loop?.maxSteps ?? config.limits?.maxSteps ?? 40, maxInvocations: t.run.loop?.maxInvocations ?? t.run.loop?.maxSteps ?? config.limits?.maxSteps ?? 40, maxMinutes: t.run.loop?.maxMinutes ?? config.limits?.maxMinutes ?? 60, startsPerHour, startsUsed },
      commands: { setup: t.run.loop?.setup ?? config.setup, check: t.run.loop?.check ?? config.check } };
  }

  private recordEvent(t: Trigger, input: FireInput, delivery?: string): AutomationEvent {
    const event: AutomationEvent = { id: `event-${randomBytes(6).toString("hex")}`, at: Date.now(), updatedAt: Date.now(), via: input.via, state: "received", input: { details: input.details, source: input.source }, delivery, retries: 0 };
    // Keep queued records even when a busy automation receives a burst of duplicate deliveries.
    const pinned = new Set((t.queued ?? []).map((q) => q.eventId));
    const history = [...(t.eventHistory ?? []), event];
    while (history.length > MAX_EVENT_HISTORY) {
      const completed = history.findIndex((e) => !pinned.has(e.id) && e.state !== "received");
      const index = completed >= 0 ? completed : history.findIndex((e) => !pinned.has(e.id));
      history.splice(index < 0 ? 0 : index, 1);
    }
    t.eventHistory = history;
    return event;
  }

  private updateEvent(t: Trigger, id: string | undefined, state: AutomationEvent["state"], reason?: string) {
    const event = id && t.eventHistory?.find((e) => e.id === id);
    if (!event) return;
    event.state = state;
    event.updatedAt = Date.now();
    event.reason = reason?.slice(0, 1_000);
  }

  private async fireOne(t: Trigger, input: FireInput): Promise<FireResult> {
    if (!t.enabled && input.via !== "manual") return { skipped: "This automation is disabled" };
    if (t.sweep) return this.fireSweep(t, input);
    // Everything up to `starting.add` is synchronous: two webhooks at once can't both get past it.
    const busy = this.busy(t);
    if (busy) return input.via === "webhook" ? this.enqueue(t, input, busy) : { skipped: busy };
    const startedAt = Date.now();
    if (input.via === "webhook" && !this.takeWebhookSlot(t, WEBHOOK_RUNS_PER_HOUR, startedAt)) {
      await this.save();
      return { skipped: t.lastError };
    }
    this.starting.add(t.id);
    const body: Record<string, any> = {
      ...t.run,
      task: input.details?.trim() ? `${t.run.task}\n\n## Details from the ${input.via}\n${input.details.trim().slice(0, 4_000)}` : t.run.task,
      source: input.source ?? t.run.source,
      loop: { ...(t.run.loop ?? {}), container: t.isolate ? { image: t.image || "node:22", network: true } : undefined },
    };
    t.lastFiredAt = startedAt;
    try {
      const run = await this.startRun(body, { trigger: { id: t.id, name: t.name, via: input.via } });
      t.lastRunId = run.id;
      t.lastError = undefined;
      return { run };
    } catch (err) {
      t.lastError = (err as Error).message;
      if (input.via === "webhook") this.releaseWebhookSlot(t, startedAt);
      throw err;
    } finally {
      this.starting.delete(t.id);
      await this.save();
    }
  }

  /** Why the automation can't start a run right now, if it can't. */
  private busy(t: Trigger): string | undefined {
    if (this.starting.has(t.id)) return "it's starting a run right now";
    const previous = t.lastRunId ? this.manager.get(t.lastRunId) : undefined;
    if (previous?.status === "running") return `the previous run (${previous.id}) is still running`;
    return undefined;
  }

  /** Keep a webhook event for when the running run ends; the same event twice is kept once. */
  private async enqueue(t: Trigger, input: FireInput, busy: string): Promise<FireResult> {
    const { via: _via, ...event } = input;
    const key = eventKey(event);
    const unique = (t.queued ?? []).filter((q) => {
      if (eventKey(q) !== key) return true;
      this.updateEvent(t, q.eventId, "deduplicated", "A newer delivery describes the same queued work");
      return false;
    });
    const queue = [...unique, event];
    for (const dropped of queue.slice(0, -MAX_QUEUED)) this.updateEvent(t, dropped.eventId, "dropped", `The queue limit of ${MAX_QUEUED} events was reached`);
    t.queued = queue.slice(-MAX_QUEUED);
    await this.save();
    return { skipped: `${busy}; this event fires when it ends`, queued: true };
  }

  private runChanged(run: RunSummary) {
    const t = run.trigger && run.status !== "running" ? this.get(run.trigger.id) : undefined;
    if (t?.queued?.length && t.lastRunId === run.id) void this.drain(t);
  }

  /** Fire the oldest webhook event that waited, once nothing of this automation is running. */
  private async drain(t: Trigger) {
    if (!t.queued?.length || this.busy(t)) return;
    const [next, ...rest] = t.queued;
    t.queued = rest.length ? rest : undefined;
    if (!t.enabled || !this.get(t.id)) return void this.save();
    await this.fire(t.id, { via: "webhook", ...next! }).catch((err) =>
      logWarn(`Automation "${t.name}" couldn't start a webhook run that waited`, { error: (err as Error).message }),
    );
  }

  /**
   * Room for one more webhook-started run this hour (`perHour` of them), taken at once so
   * concurrent deliveries count too. Without room the event is dropped and that's recorded:
   * an outsider opening 50 issues mustn't start 50 runs.
   */
  private takeWebhookSlot(t: Trigger, perHour: number, now: number): boolean {
    const recent = (t.webhookStarts ?? []).filter((at) => now - at < HOUR);
    if (recent.length >= perHour) {
      t.webhookStarts = recent;
      t.lastError = `Ignored a webhook event: this automation already started ${recent.length} runs from webhooks in the last hour (at most ${perHour})`;
      return false;
    }
    t.webhookStarts = [...recent, now];
    return true;
  }

  private releaseWebhookSlot(t: Trigger, at: number) {
    const i = t.webhookStarts?.lastIndexOf(at) ?? -1;
    if (i >= 0) t.webhookStarts!.splice(i, 1);
  }

  private claims(t: Trigger): Set<string> {
    let set = this.claimed.get(t.id);
    if (!set) this.claimed.set(t.id, (set = new Set()));
    return set;
  }

  /**
   * A sweep fires: a webhook names one item (an issue, PR or alert); a schedule or "Run now" lists
   * the work and starts a run for each new item that would be picked by default, up to `max`.
   * Items already started (or covered by another run) are left alone.
   */
  private async fireSweep(t: Trigger, input: FireInput): Promise<FireResult & { runs: Run[] }> {
    if (input.source) return this.fireSweepItem(t, input, input.source);
    if (!this.listSweep) throw new Error("Sweeps aren't available here");
    if (this.sweeping.has(t.id)) return { runs: [], skipped: "it's already sweeping" };
    this.sweeping.add(t.id);
    const sweep = t.sweep!;
    const claimed = this.claims(t);
    const mine: string[] = [];
    t.lastFiredAt = Date.now();
    try {
      const list = await this.listSweep(t.run.repo, sweep.kind);
      const handled = new Set(t.handled ?? []);
      if (upgradeLegacyKeys(list, handled)) t.handled = [...handled].slice(-MAX_HANDLED);
      const items = nextSweepItems(list, new Set([...handled, ...claimed]), sweep.max);
      for (const item of items) for (const key of sourceKeys(item.source)) claimed.add(key), mine.push(key);
      if (!items.length) {
        t.lastError = undefined;
        return { runs: [], skipped: "nothing new to sweep" };
      }
      const runs: Run[] = [];
      const errors: string[] = [];
      for (const item of items) {
        try {
          runs.push(await this.startRun(this.sweepRun(t, item.task, item.source), { trigger: { id: t.id, name: t.name, via: input.via } }));
          this.handle(t, sourceKeys(item.source));
        } catch (err) {
          errors.push(`${item.key}: ${(err as Error).message}`);
          const failed = this.recordEvent(t, { ...input, source: item.source });
          this.updateEvent(t, failed.id, "failed", `${item.key}: ${(err as Error).message}`);
        }
      }
      t.lastRunId = runs.at(-1)?.id ?? t.lastRunId;
      t.lastError = errors.length ? errors.join("; ").slice(0, 1_000) : undefined;
      if (!runs.length && errors.length) throw new Error(t.lastError);
      return { runs };
    } finally {
      for (const key of mine) claimed.delete(key);
      this.sweeping.delete(t.id);
      await this.save();
    }
  }

  /**
   * A webhook names one item. It goes through the same rules as the sweep's list: the event
   * must be the sweep's kind, and the item must be one the list would pick (not labelled
   * wontfix or question, not a green Dependabot PR, not a low-severity or unpatched alert, not
   * already covered by a run) — at most `max` runs an hour.
   */
  private async fireSweepItem(t: Trigger, input: FireInput, source: SourceInput): Promise<FireResult & { runs: Run[] }> {
    const sweep = t.sweep!;
    if (!sweepTakes(sweep.kind, source)) return { runs: [], skipped: `a ${sweep.kind} sweep doesn't start from ${source.kind === "pr" ? "a pull request" : `an ${source.kind}`}` };
    const claimed = this.claims(t);
    const keys = sourceKeys(source);
    if (keys.every((k) => (t.handled ?? []).includes(k) || claimed.has(k))) return { runs: [], skipped: "nothing new to sweep" };
    const startedAt = Date.now();
    if (input.via === "webhook" && !this.takeWebhookSlot(t, sweep.max, startedAt)) {
      await this.save();
      return { runs: [], skipped: t.lastError };
    }
    // Claimed before anything is awaited, so the same event twice starts one run.
    const mine = keys.filter((k) => !claimed.has(k));
    for (const key of mine) claimed.add(key);
    let started = false;
    t.lastFiredAt = startedAt;
    try {
      if (!this.listSweep) throw new Error("Sweeps aren't available here");
      const list = await this.listSweep(t.run.repo, sweep.kind);
      const handled = new Set(t.handled ?? []);
      if (upgradeLegacyKeys(list, handled)) t.handled = [...handled].slice(-MAX_HANDLED);
      const item = findSweepItem(list, source);
      if (!item?.source || !item.task || item.manual) return { runs: [], skipped: "it isn't in the sweep's list (closed, or not the kind this sweep fixes)" };
      if (!item.selected) return { runs: [], skipped: `the sweep wouldn't pick it: ${item.note ?? "not picked by default"}` };
      // An alert's item can cover more alerts on the same package: claim those too.
      const itemKeys = sourceKeys(item.source);
      if (itemKeys.every((k) => handled.has(k))) return { runs: [], skipped: "nothing new to sweep" };
      if (itemKeys.some((k) => claimed.has(k) && !mine.includes(k))) return { runs: [], skipped: "a run for it is starting right now" };
      for (const key of itemKeys) if (!claimed.has(key)) claimed.add(key), mine.push(key);
      const details = input.details?.trim() ? `\n\n## Details from the webhook\n${input.details.trim().slice(0, 4_000)}` : "";
      const run = await this.startRun(this.sweepRun(t, item.task + details, item.source), { trigger: { id: t.id, name: t.name, via: input.via } });
      started = true;
      this.handle(t, itemKeys);
      t.lastRunId = run.id;
      t.lastError = undefined;
      return { runs: [run] };
    } catch (err) {
      t.lastError = (err as Error).message.slice(0, 1_000);
      throw err;
    } finally {
      if (!started && input.via === "webhook") this.releaseWebhookSlot(t, startedAt);
      for (const key of mine) claimed.delete(key);
      await this.save();
    }
  }

  private sweepRun(t: Trigger, task: string, source: SourceInput): Record<string, any> {
    return { ...t.run, task, source, loop: { ...(t.run.loop ?? {}), container: t.isolate ? { image: t.image || "node:22", network: true } : undefined } };
  }

  private handle(t: Trigger, keys: string[]) {
    t.handled = [...new Set([...(t.handled ?? []), ...keys])].slice(-MAX_HANDLED);
  }

  /**
   * Check a webhook call: `Authorization: Bearer <token>`, or GitHub's `X-Hub-Signature-256`
   * (HMAC of the body with the token as the secret).
   */
  authorize(id: string, headers: Record<string, string | string[] | undefined>, body: Buffer): Trigger {
    const t = this.get(id);
    if (!t || !t.webhook) throw Object.assign(new Error("Not found"), { status: 404 });
    if (!t.enabled) throw Object.assign(new Error("This automation is turned off"), { status: 409 });
    const bearer = String(headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const signature = String(headers["x-hub-signature-256"] ?? "");
    const expected = `sha256=${createHmac("sha256", t.token).update(body).digest("hex")}`;
    if (!(bearer && same(bearer, t.token)) && !(signature && same(signature, expected))) {
      throw Object.assign(new Error("Bad token or signature"), { status: 401 });
    }
    return t;
  }

  /**
   * Changes you make must be saved, or a webhook secret you copied would be gone after a restart:
   * refuse them while triggers.json couldn't be read (and so isn't written).
   */
  private requireWritable() {
    if (!this.writable) throw new Error(`Automations can't be changed: ${this.file} couldn't be read when code-flow started (see server.log). Fix or remove it, then restart code-flow.`);
  }

  private require(id: string): Trigger {
    const t = this.get(id);
    if (!t) throw new Error("Automation not found");
    return t;
  }

  private save() {
    if (!this.writable) return this.saving;
    this.saving = this.saving
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, JSON.stringify(this.triggers, null, 2), { mode: 0o600 });
        await rename(tmp, this.file);
      })
      .catch((err) => logError(`Couldn't save automations to ${this.file}`, err));
    return this.saving;
  }
}

/** Only documented event fields may be retained or replayed. */
export function validateFireInput(raw: unknown): FireInput {
  if (!raw || typeof raw !== "object") throw new Error("Invalid automation event");
  const input = raw as Record<string, any>;
  if (!["manual", "schedule", "webhook"].includes(input.via)) throw new Error("Invalid automation event origin");
  if (input.details !== undefined && typeof input.details !== "string") throw new Error("Automation event details must be text");
  let source: SourceInput | undefined;
  if (input.source !== undefined) {
    const s = input.source;
    if (!s || typeof s !== "object" || !["issue", "pr", "alert"].includes(s.kind) || !Number.isSafeInteger(s.number) || s.number < 1) throw new Error("Invalid automation event source");
    if (s.kind === "alert" && !["dependabot", "code-scanning"].includes(s.tool)) throw new Error("Invalid automation alert tool");
    if (s.numbers !== undefined && (!Array.isArray(s.numbers) || s.numbers.length > 20 || s.numbers.some((n: unknown) => !Number.isSafeInteger(n) || (n as number) < 1))) throw new Error("Invalid automation alert numbers");
    source = { kind: s.kind, number: s.number, ...(s.kind === "alert" ? { tool: s.tool, ...(s.numbers ? { numbers: [...new Set<number>(s.numbers)] } : {}) } : { ciLogs: s.ciLogs === true }) };
  }
  return { via: input.via, details: input.details?.slice(0, 4_000), source };
}

/** Two webhook events that would start the same run. */
function eventKey(event: Omit<FireInput, "via">): string {
  return event.source ? sourceKeys(event.source).join(",") : `details:${event.details ?? ""}`;
}

/**
 * One saved automation, checked: anything without an id, a secret and a run to start can't be
 * used. One whose schedule or sweep can't be read is kept (with its secret) but turned off.
 */
function readTrigger(raw: any): Trigger | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  if (typeof raw.id !== "string" || !raw.id || typeof raw.token !== "string" || raw.token.length < 16) return undefined;
  const run = raw.run;
  if (!run || typeof run !== "object" || typeof run.repo !== "string" || typeof run.pattern !== "string" || typeof run.task !== "string") return undefined;
  const problems: string[] = [];
  let schedule: Schedule | undefined;
  try {
    schedule = validateSchedule(raw.schedule);
  } catch {
    problems.push("its schedule couldn't be read; set it again");
  }
  let sweep: Trigger["sweep"];
  if (raw.sweep !== undefined) {
    if (raw.sweep && SWEEP_KINDS.includes(raw.sweep.kind)) sweep = { kind: raw.sweep.kind, max: Math.min(10, Math.max(1, Math.round(Number(raw.sweep.max)) || 5)) };
    else problems.push("its sweep couldn't be read");
  }
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
  const time = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const queued = Array.isArray(raw.queued) ? raw.queued.slice(-MAX_QUEUED).flatMap((q: any) => {
    try { const { via: _via, ...input } = validateFireInput({ ...q, via: "webhook" }); return [{ ...input, ...(typeof q.eventId === "string" ? { eventId: q.eventId.slice(0, 100) } : {}) }]; }
    catch { return []; }
  }) : undefined;
  const eventHistory: AutomationEvent[] | undefined = Array.isArray(raw.eventHistory) ? raw.eventHistory.slice(-MAX_EVENT_HISTORY).flatMap((event: any): AutomationEvent[] => {
    try {
      if (!event || typeof event.id !== "string" || !["received", "queued", "started", "failed", "dropped", "deduplicated", "skipped"].includes(event.state)) return [];
      const { via, ...input } = validateFireInput({ ...event.input, via: event.via });
      return [{ id: event.id.slice(0, 100), at: time(event.at) ?? Date.now(), updatedAt: time(event.updatedAt) ?? Date.now(), via, input,
        state: event.state === "received" ? "failed" : event.state,
        reason: event.state === "received" ? "code-flow restarted before this event finished starting" : typeof event.reason === "string" ? event.reason.slice(0, 1_000) : undefined,
        delivery: typeof event.delivery === "string" ? event.delivery.slice(0, 200) : undefined,
        runIds: strings(event.runIds)?.slice(0, 10), retries: Number.isSafeInteger(event.retries) && event.retries > 0 ? event.retries : 0 }];
    } catch { return []; }
  }) : undefined;
  if (problems.length) logWarn(`Automation "${raw.name ?? raw.id}" was turned off: ${problems.join("; ")}`);
  return {
    id: raw.id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.slice(0, 80) : "Automation",
    enabled: raw.enabled === true && !problems.length,
    run,
    schedule,
    webhook: raw.webhook === true,
    token: raw.token,
    isolate: raw.isolate === true,
    image: typeof raw.image === "string" ? raw.image : undefined,
    createdAt: time(raw.createdAt) ?? Date.now(),
    nextAt: time(raw.nextAt),
    lastFiredAt: time(raw.lastFiredAt),
    lastRunId: typeof raw.lastRunId === "string" ? raw.lastRunId : undefined,
    lastError: problems.length ? `Turned off: ${problems.join("; ")}` : typeof raw.lastError === "string" ? raw.lastError : undefined,
    sweep,
    handled: strings(raw.handled)?.slice(-MAX_HANDLED),
    deliveries: strings(raw.deliveries)?.slice(-MAX_DELIVERIES),
    queued: queued?.length ? queued : undefined,
    eventHistory,
    webhookStarts: Array.isArray(raw.webhookStarts) ? raw.webhookStarts.filter((n: unknown) => time(n) !== undefined) : undefined,
  };
}

/**
 * What a webhook asks for. A plain JSON body may carry `{ details, source }`. GitHub events
 * map to a source: issues → that issue; pull_request → that PR; a failed workflow_run → its PR
 * with CI logs. Returns null for events that shouldn't start a run (pings, successes…).
 */
export function readWebhook(headers: Record<string, string | string[] | undefined>, payload: any): Omit<FireInput, "via"> | null {
  const event = String(headers["x-github-event"] ?? "");
  if (!event) {
    const source = payload?.source;
    const number = Number(source?.number);
    const tool = source?.tool === "dependabot" || source?.tool === "code-scanning" ? source.tool : undefined;
    const valid = source && (source.kind === "issue" || source.kind === "pr" || (source.kind === "alert" && tool)) && Number.isInteger(number) && number > 0;
    return {
      details: typeof payload?.details === "string" ? payload.details : typeof payload?.task === "string" ? payload.task : undefined,
      source: valid ? (source.kind === "alert" ? { kind: "alert", tool, number } : { kind: source.kind, number, ciLogs: source.ciLogs === true }) : undefined,
    };
  }
  const number = (n: unknown) => (Number.isInteger(n) && (n as number) > 0 ? (n as number) : undefined);
  // GitHub logins are letters, digits and dashes; anything else in one isn't passed on.
  const login = (u: any) => (typeof u?.login === "string" && /^[\w-]{1,39}(\[bot\])?$/.test(u.login) ? `@${u.login}` : "someone");
  // A new or reopened security alert: Dependabot's (a vulnerable dependency) or code scanning's.
  if (event === "dependabot_alert" && ["created", "reopened", "reintroduced"].includes(payload?.action) && number(payload.alert?.number)) {
    return { source: { kind: "alert", tool: "dependabot", number: payload.alert.number }, details: `GitHub: Dependabot alert ${payload.action}` };
  }
  if (event === "code_scanning_alert" && ["created", "reopened", "appeared_in_branch"].includes(payload?.action) && number(payload.alert?.number)) {
    return { source: { kind: "alert", tool: "code-scanning", number: payload.alert.number }, details: `GitHub: code scanning alert ${payload.action}` };
  }
  if (event === "issues" && ["opened", "labeled", "reopened"].includes(payload?.action) && number(payload.issue?.number)) {
    return { source: { kind: "issue", number: payload.issue.number }, details: `GitHub: issue ${payload.action} by ${login(payload.sender)}` };
  }
  if (event === "pull_request" && ["opened", "synchronize", "reopened", "ready_for_review", "labeled"].includes(payload?.action) && number(payload.pull_request?.number)) {
    return { source: { kind: "pr", number: payload.pull_request.number }, details: `GitHub: pull request ${payload.action}` };
  }
  if (event === "workflow_run" && payload?.action === "completed" && payload.workflow_run?.conclusion === "failure") {
    const pr = number(payload.workflow_run.pull_requests?.[0]?.number);
    // A PR can rename the workflow it runs: its name is the PR author's text, so only a tame form of it is kept.
    const name = String(payload.workflow_run.name ?? "").replace(/[^\w .()/-]/g, "").slice(0, 80);
    return pr ? { source: { kind: "pr", number: pr, ciLogs: true }, details: `GitHub: workflow "${name}" failed` } : null;
  }
  return null;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
