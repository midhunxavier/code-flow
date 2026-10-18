import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CODEFLOW_HOME } from "./config.js";
import type { Run, RunManager, RunSummary } from "./engine.js";
import { untrustedBlock, type SourceInput } from "./github.js";
import { logError, logInfo, logWarn } from "./log.js";
import { findSweepItem, nextSweepItems, sourceKeys, sweepTakes, upgradeLegacyKeys, type SweepKind, type SweepList } from "./sweeps.js";

/**
 * Automations: a saved run (repo, pattern, task, team, settings) that starts on a schedule, from
 * a webhook, or when you press "Run now". Their results wait in the inbox for you to approve,
 * revise or reject — nothing is merged automatically.
 */

export type Schedule = { every: number } | { at: string; days?: number[] };

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
  /**
   * The latest webhook deliveries, so one sent again doesn't start another run: GitHub's ids, and
   * for a delivery signed with GitHub's signature the hash of its body too ("sha256:…").
   */
  deliveries?: string[];
  /** Webhook events that came in while this automation's run was going; each fires when it ends. */
  queued?: Omit<FireInput, "via">[];
  /** When webhooks started runs, over the last hour (they're capped per hour). */
  webhookStarts?: number[];
}

/** What a webhook or schedule adds to the saved run. */
export interface FireInput {
  via: "schedule" | "webhook" | "manual";
  /**
   * Text the caller sent for the task (a webhook body's `details` or `task`). Anyone with the
   * automation's secret can send it, and programs on this machine (the agents among them) can read
   * that secret in triggers.json, so it reaches the agents fenced as data and the run is marked as
   * carrying untrusted text (see `withDetails`).
   */
  details?: string;
  /** code-flow's own line about the GitHub event that fired it ("GitHub: issue opened by @bob"). */
  event?: string;
  source?: SourceInput;
}

/** How a webhook call proved it may fire the automation. */
export interface Caller {
  trigger: Trigger;
  /** By GitHub's signature of the body, rather than the secret itself as a Bearer token. */
  signed: boolean;
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
    const days = Array.isArray(raw.days) ? [...new Set(raw.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : undefined;
    return { at: raw.at, days: days?.length && days.length < 7 ? days : undefined };
  }
  throw new Error("A schedule needs every (minutes) or at (HH:MM)");
}

/** The next time `schedule` fires after `after` (local time), always on a day it allows. */
export function nextFire(schedule: Schedule, after: number): number {
  if ("every" in schedule) return after + schedule.every * 60_000;
  const [h, m] = schedule.at.split(":").map(Number) as [number, number];
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

/**
 * Whether a time the schedule was due at (`due`) should still fire at `now`: code-flow was
 * closed or the computer asleep, and it's at most an hour late, and the day it was due on is
 * one of the schedule's days (Monday's 23:30, fired at 00:10 on Tuesday, still counts).
 * Otherwise that time is skipped.
 */
export function stillDue(schedule: Schedule, due: number, now: number): boolean {
  if (now - due > MISSED_GRACE_MS) return false;
  return "every" in schedule || !schedule.days?.length || schedule.days.includes(new Date(due).getDay());
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
  return `${days} at ${schedule.at}`;
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
    /**
     * Starts a run exactly like POST /api/runs (validation, Auto roles…). `untrustedText`: its task
     * carries a webhook caller's text, so the run is marked like one from an outsider's words.
     */
    private readonly startRun: (body: Record<string, any>, extra: { trigger: NonNullable<Run["trigger"]>; untrustedText?: boolean }) => Promise<Run>,
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
    input: Omit<Trigger, "id" | "token" | "createdAt" | "nextAt" | "handled" | "deliveries" | "queued" | "webhookStarts"> & { handled?: string[] },
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
    if (!t.enabled) t.queued = undefined;
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
   *
   * GitHub's signature covers the body but not the X-GitHub-Delivery id, so anyone who saw one
   * signed delivery (a tunnel's log, plain HTTP on the Wi-Fi) could send it again with the id
   * changed or left out. A signed body (`signedBody`) that came before is a replay whatever id it
   * carries, or none.
   */
  accept(id: string, input: Omit<FireInput, "via">, delivery?: string, signedBody?: Buffer): { accepted: true } | { ignored: string } {
    const t = this.require(id);
    const body = signedBody && `sha256:${createHash("sha256").update(signedBody).digest("hex")}`;
    if (delivery && t.deliveries?.includes(delivery)) return { ignored: `Delivery ${delivery} was already handled` };
    if (body && t.deliveries?.includes(body)) return { ignored: "This delivery was already handled: the same signed body came before" };
    const seen = [delivery, body].filter((k): k is string => !!k);
    if (seen.length) {
      t.deliveries = [...(t.deliveries ?? []), ...seen].slice(-MAX_DELIVERIES);
      void this.save();
    }
    void this.fire(id, { via: "webhook", ...input }).then(
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
      task: withDetails(t.run.task, input),
      source: input.source ?? t.run.source,
      loop: { ...(t.run.loop ?? {}), container: t.isolate ? { image: t.image || "node:22", network: true } : undefined },
    };
    t.lastFiredAt = startedAt;
    try {
      const run = await this.startRun(body, { trigger: { id: t.id, name: t.name, via: input.via }, ...(hasDetails(input) && { untrustedText: true }) });
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
    t.queued = [...(t.queued ?? []).filter((q) => eventKey(q) !== key), event].slice(-MAX_QUEUED);
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
      const run = await this.startRun(this.sweepRun(t, withDetails(item.task, input), item.source), {
        trigger: { id: t.id, name: t.name, via: input.via },
        ...(hasDetails(input) && { untrustedText: true }),
      });
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
   * (HMAC of the body with the token as the secret). Says which, since a signed body can be sent
   * again by anyone who saw it, and the secret can't.
   */
  authorize(id: string, headers: Record<string, string | string[] | undefined>, body: Buffer): Caller {
    const t = this.get(id);
    if (!t || !t.webhook) throw Object.assign(new Error("Not found"), { status: 404 });
    if (!t.enabled) throw Object.assign(new Error("This automation is turned off"), { status: 409 });
    const bearer = String(headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (bearer && same(bearer, t.token)) return { trigger: t, signed: false };
    const signature = String(headers["x-hub-signature-256"] ?? "");
    const expected = `sha256=${createHmac("sha256", t.token).update(body).digest("hex")}`;
    if (signature && same(signature, expected)) return { trigger: t, signed: true };
    throw Object.assign(new Error("Bad token or signature"), { status: 401 });
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

/** Two webhook events that would start the same run. */
function eventKey(event: Omit<FireInput, "via">): string {
  return event.source ? sourceKeys(event.source).join(",") : `details:${event.details ?? ""}`;
}

const hasDetails = (input: Omit<FireInput, "via">) => !!input.details?.trim();

/**
 * The task with what the event added. code-flow's own line about a GitHub event goes in as it is.
 * The caller's text goes in a fence it can't close (untrustedBlock), with a note that it's
 * information, not instructions: it runs with the automation's settings, and anyone with the
 * secret could have written it. The task stays the saved one when nothing was added.
 */
function withDetails(task: string, input: FireInput): string {
  const details = input.details?.trim().slice(0, 4_000);
  const parts = [input.event?.trim(), details && untrustedBlock(`text sent with the ${input.via}`, details)].filter(Boolean);
  return parts.length ? `${task}\n\n## Details from the ${input.via}\n${parts.join("\n\n")}` : task;
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
  const queued = Array.isArray(raw.queued)
    ? raw.queued
        .filter((q: any) => q && typeof q === "object")
        .map((q: any) => ({
          details: typeof q.details === "string" ? q.details : undefined,
          event: typeof q.event === "string" ? q.event : undefined,
          source: q.source && typeof q.source === "object" ? q.source : undefined,
        }))
        .slice(-MAX_QUEUED)
    : undefined;
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
    webhookStarts: Array.isArray(raw.webhookStarts) ? raw.webhookStarts.filter((n: unknown) => time(n) !== undefined) : undefined,
  };
}

/**
 * What a webhook asks for. A plain JSON body may carry `{ details, source }`. GitHub events
 * map to a source: issues → that issue; pull_request → that PR; a failed workflow_run → its PR
 * with CI logs. Returns null for events that shouldn't start a run (pings, successes…). A GitHub
 * event's line for the task is code-flow's own words (`event`), built from fields it checked;
 * none of the payload's free text goes in as `details`.
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
    return { source: { kind: "alert", tool: "dependabot", number: payload.alert.number }, event: `GitHub: Dependabot alert ${payload.action}` };
  }
  if (event === "code_scanning_alert" && ["created", "reopened", "appeared_in_branch"].includes(payload?.action) && number(payload.alert?.number)) {
    return { source: { kind: "alert", tool: "code-scanning", number: payload.alert.number }, event: `GitHub: code scanning alert ${payload.action}` };
  }
  if (event === "issues" && ["opened", "labeled", "reopened"].includes(payload?.action) && number(payload.issue?.number)) {
    return { source: { kind: "issue", number: payload.issue.number }, event: `GitHub: issue ${payload.action} by ${login(payload.sender)}` };
  }
  if (event === "pull_request" && ["opened", "synchronize", "reopened", "ready_for_review", "labeled"].includes(payload?.action) && number(payload.pull_request?.number)) {
    return { source: { kind: "pr", number: payload.pull_request.number }, event: `GitHub: pull request ${payload.action}` };
  }
  if (event === "workflow_run" && payload?.action === "completed" && payload.workflow_run?.conclusion === "failure") {
    const pr = number(payload.workflow_run.pull_requests?.[0]?.number);
    // A PR can rename the workflow it runs: its name is the PR author's text, so only a tame form of it is kept.
    const name = String(payload.workflow_run.name ?? "").replace(/[^\w .()/-]/g, "").slice(0, 80);
    return pr ? { source: { kind: "pr", number: pr, ciLogs: true }, event: `GitHub: workflow "${name}" failed` } : null;
  }
  return null;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
