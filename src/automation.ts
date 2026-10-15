import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CODEFLOW_HOME } from "./config.js";
import type { Run, RunManager } from "./engine.js";

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
  nextAt?: number;
  lastFiredAt?: number;
  lastRunId?: string;
  lastError?: string;
}

/** What a webhook or schedule adds to the saved run. */
export interface FireInput {
  via: "schedule" | "webhook" | "manual";
  /** Extra text for the task (e.g. from a webhook payload). */
  details?: string;
  source?: { kind: "issue" | "pr"; number: number; ciLogs?: boolean };
}

const FILE = join(CODEFLOW_HOME, "triggers.json");
const MIN_EVERY_MINUTES = 5;

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

/** The next time `schedule` fires after `after` (local time). Missed times are skipped, not caught up. */
export function nextFire(schedule: Schedule, after: number): number {
  if ("every" in schedule) return after + schedule.every * 60_000;
  const [h, m] = schedule.at.split(":").map(Number) as [number, number];
  const d = new Date(after);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= after) d.setDate(d.getDate() + 1);
  for (let i = 0; i < 7 && schedule.days?.length && !schedule.days.includes(d.getDay()); i++) d.setDate(d.getDate() + 1);
  return d.getTime();
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
  private saving: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly manager: RunManager,
    /** Starts a run exactly like POST /api/runs (validation, Auto roles…). */
    private readonly startRun: (body: Record<string, any>, extra: { trigger: NonNullable<Run["trigger"]> }) => Promise<Run>,
  ) {}

  async load() {
    if (existsSync(FILE)) {
      try {
        this.triggers = JSON.parse(await readFile(FILE, "utf8"));
      } catch {
        this.triggers = [];
      }
    }
    const now = Date.now();
    for (const t of this.triggers) t.nextAt = t.enabled && t.schedule ? nextFire(t.schedule, now) : undefined;
  }

  list(): Trigger[] {
    return this.triggers.map((t) => ({ ...t }));
  }

  get(id: string): Trigger | undefined {
    return this.triggers.find((t) => t.id === id);
  }

  async create(input: Omit<Trigger, "id" | "token" | "createdAt" | "nextAt">): Promise<Trigger> {
    const trigger: Trigger = { ...input, id: `t-${randomBytes(4).toString("hex")}`, token: randomBytes(24).toString("hex"), createdAt: Date.now() };
    trigger.nextAt = trigger.enabled && trigger.schedule ? nextFire(trigger.schedule, Date.now()) : undefined;
    this.triggers.push(trigger);
    await this.save();
    return { ...trigger };
  }

  async update(id: string, patch: Partial<Pick<Trigger, "name" | "enabled" | "schedule" | "webhook" | "isolate" | "image" | "run">> & { rotateToken?: boolean }) {
    const t = this.require(id);
    const { rotateToken, ...rest } = patch;
    Object.assign(t, rest);
    if ("schedule" in patch && !patch.schedule) t.schedule = undefined;
    if (rotateToken) t.token = randomBytes(24).toString("hex");
    t.nextAt = t.enabled && t.schedule ? nextFire(t.schedule, Date.now()) : undefined;
    await this.save();
    return { ...t };
  }

  async remove(id: string) {
    this.require(id);
    this.triggers = this.triggers.filter((t) => t.id !== id);
    await this.save();
  }

  start(tickMs = 30_000) {
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Fire every enabled schedule that is due. */
  async tick(now = Date.now()) {
    for (const t of this.triggers) {
      if (!t.enabled || !t.schedule || !t.nextAt || t.nextAt > now) continue;
      t.nextAt = nextFire(t.schedule, now);
      await this.fire(t.id, { via: "schedule" }).catch(() => undefined);
    }
    await this.save();
  }

  /**
   * Start the automation's run. If its previous run is still going, this one is skipped:
   * automations never pile up.
   */
  async fire(id: string, input: FireInput): Promise<{ run?: Run; skipped?: string }> {
    const t = this.require(id);
    const previous = t.lastRunId ? this.manager.get(t.lastRunId) : undefined;
    if (previous?.status === "running") {
      return { skipped: `the previous run (${previous.id}) is still running` };
    }
    const body: Record<string, any> = {
      ...t.run,
      task: input.details?.trim() ? `${t.run.task}\n\n## Details from the ${input.via}\n${input.details.trim().slice(0, 4_000)}` : t.run.task,
      source: input.source ?? t.run.source,
      loop: { ...(t.run.loop ?? {}), container: t.isolate ? { image: t.image || "node:22", network: true } : undefined },
    };
    t.lastFiredAt = Date.now();
    try {
      const run = await this.startRun(body, { trigger: { id: t.id, name: t.name, via: input.via } });
      t.lastRunId = run.id;
      t.lastError = undefined;
      return { run };
    } catch (err) {
      t.lastError = (err as Error).message;
      throw err;
    } finally {
      await this.save();
    }
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

  private require(id: string): Trigger {
    const t = this.get(id);
    if (!t) throw new Error("Automation not found");
    return t;
  }

  private save() {
    this.saving = this.saving.then(async () => {
      await mkdir(dirname(FILE), { recursive: true });
      const tmp = `${FILE}.tmp`;
      await writeFile(tmp, JSON.stringify(this.triggers, null, 2), { mode: 0o600 });
      await rename(tmp, FILE);
    }).catch(() => undefined);
    return this.saving;
  }
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
    const valid = source && (source.kind === "issue" || source.kind === "pr") && Number.isInteger(Number(source.number)) && Number(source.number) > 0;
    return {
      details: typeof payload?.details === "string" ? payload.details : typeof payload?.task === "string" ? payload.task : undefined,
      source: valid ? { kind: source.kind, number: Number(source.number), ciLogs: source.ciLogs === true } : undefined,
    };
  }
  if (event === "issues" && ["opened", "labeled", "reopened"].includes(payload?.action) && payload.issue?.number) {
    return { source: { kind: "issue", number: payload.issue.number }, details: `GitHub: issue ${payload.action} by @${payload.sender?.login ?? "someone"}` };
  }
  if (event === "pull_request" && ["opened", "synchronize", "reopened", "ready_for_review", "labeled"].includes(payload?.action) && payload.pull_request?.number) {
    return { source: { kind: "pr", number: payload.pull_request.number }, details: `GitHub: pull request ${payload.action}` };
  }
  if (event === "workflow_run" && payload?.action === "completed" && payload.workflow_run?.conclusion === "failure") {
    const pr = payload.workflow_run.pull_requests?.[0]?.number;
    return pr ? { source: { kind: "pr", number: pr, ciLogs: true }, details: `GitHub: workflow "${payload.workflow_run.name}" failed` } : null;
  }
  return null;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
