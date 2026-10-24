import { checksLabel } from "./run-status.js";
import type { ProjectTeam } from "./project-team-model.js";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CODEFLOW_HOME } from "./config.js";
import type { RunSummary } from "./engine.js";
import { registerPrivateEnvNames } from "./env.js";
import { logWarn } from "./log.js";
import { redactExport, redactText } from "./privacy.js";

export type NotificationEvent = "done" | "failure" | "needs-attention";
export interface NotificationSettings { enabled: boolean; events: NotificationEvent[]; projects: "all" | string[] }
export interface TargetConfig { id: string; name: string; protocol: "webhook" | "slack"; urlEnv: string; secretEnv?: string }
interface SavedSettings extends NotificationSettings { destinationHash?: string; dropped?: number; lastError?: string }
interface NotificationPayload { version: 1; id: string; event: NotificationEvent; runId: string; teamId?: string; cycleId?: string; project?: string; pattern: string; status: string; result: string; title: string; test?: boolean }
export interface NotificationDelivery {
  id: string;
  target: string;
  event: NotificationEvent;
  runId: string;
  teamId?: string;
  cycleId?: string;
  project?: string;
  state: "pending" | "sending" | "delivered" | "failed" | "cancelled";
  attempts: number;
  totalAttempts?: number;
  retryCount?: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt?: number;
  httpStatus?: number;
  reason?: string;
  manual?: boolean;
}
interface SavedDelivery extends NotificationDelivery { destinationHash: string; payload: NotificationPayload }
interface SavedState { version: 1; settings: Record<string, SavedSettings>; deliveries: SavedDelivery[]; seen: string[] }
const EVENTS: NotificationEvent[] = ["done", "failure", "needs-attention"];
const MAX_DELIVERIES = 200;
const MAX_SEEN = 2_000;
const MAX_ATTEMPTS = 3;
const MAX_PENDING_AGE = 24 * 60 * 60_000;
const EMPTY = (): SavedState => ({ version: 1, settings: Object.create(null), deliveries: [], seen: [] });
const defaults = (): SavedSettings => ({ enabled: false, events: [], projects: [] });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : "";

/** Only actionable changes produce candidates; polling timestamps do not change their identity. */
export function notificationEvents(run: RunSummary): { event: NotificationEvent; key: string }[] {
  if (run.archived || run.projectTeam) return [];
  const candidates: { event: NotificationEvent; key: string }[] = [];
  if (run.endedAt && ["done", "failed", "stopped", "interrupted"].includes(run.status)) {
    const failed = run.status !== "done" || ["Failed", "Blocked"].includes(checksLabel(run));
    candidates.push({ event: failed ? "failure" : "done", key: `${run.id}:ended:${run.endedAt}` });
  }
  const attention = run.awaiting ? ["approval", run.awaiting.kind, run.awaiting.at] : run.team?.awaitingRequestId ? ["question", run.team.awaitingRequestId] : run.triage?.state === "pending" ? ["triage", run.triage.at] : run.team?.status === "blocked" ? ["blocked", run.team.gaps] : undefined;
  if (attention) candidates.push({ event: "needs-attention", key: `${run.id}:attention:${digest(attention)}` });
  for (const watch of Object.values(run.watches ?? {})) if (watch.state === "needs-you") candidates.push({ event: "needs-attention", key: `${run.id}:watch:${digest([watch.branch, watch.detail, watch.fixes])}` });
  return candidates;
}

export function validateNotificationSettings(value: unknown): NotificationSettings {
  if (!value || typeof value !== "object") throw new Error("Choose notification settings");
  const raw = value as Record<string, unknown>;
  if (typeof raw.enabled !== "boolean" || !Array.isArray(raw.events) || raw.events.length > 3 || raw.events.some((event) => !EVENTS.includes(event))) throw new Error("Choose valid notification events and enabled state");
  const events = [...new Set(raw.events)] as NotificationEvent[];
  if (raw.projects !== "all" && (!Array.isArray(raw.projects) || raw.projects.length > 100 || raw.projects.some((project) => typeof project !== "string" || !/^[\w-]{1,100}$/.test(project)))) throw new Error("Choose all projects or explicit project IDs");
  const projects = raw.projects === "all" ? "all" : [...new Set(raw.projects as string[])];
  if (raw.enabled && (!events.length || projects !== "all" && !projects.length)) throw new Error("Enabling notifications requires an event and a project scope");
  return { enabled: raw.enabled, events, projects };
}

function targetConfigs(input: unknown): TargetConfig[] {
    if (!Array.isArray(input) || input.length > 20) throw new Error("Configure at most 20 notification destinations");
    const ids = new Set<string>();
    return input.map((raw: any): TargetConfig => {
      if (!raw || !/^[a-z][a-z0-9-]{0,63}$/.test(raw.id) || ids.has(raw.id) || !["webhook", "slack"].includes(raw.protocol)) throw new Error("Notification destinations need unique IDs and webhook or slack protocol");
      ids.add(raw.id);
      if (typeof raw.urlEnv !== "string" || !/^[A-Z_][A-Z0-9_]{0,99}$/.test(raw.urlEnv) || raw.secretEnv !== undefined && (typeof raw.secretEnv !== "string" || !/^[A-Z_][A-Z0-9_]{0,99}$/.test(raw.secretEnv))) throw new Error("Notification credentials must name server environment variables");
      return { id: raw.id, name: text(raw.name, 80) || raw.id, protocol: raw.protocol, urlEnv: raw.urlEnv, secretEnv: raw.secretEnv };
    });
}

export class Notifications {
  private configs: TargetConfig[] = [];
  private administratorConfigs: TargetConfig[] = [];
  private managedEnvironment: NodeJS.ProcessEnv = {};
  private state: SavedState = EMPTY();
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  private draining?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private readonly file: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  constructor(options: { file?: string; environment?: NodeJS.ProcessEnv; fetch?: typeof fetch; now?: () => number } = {}) {
    this.file = options.file ?? join(CODEFLOW_HOME, "notifications.json");
    this.environment = options.environment ?? process.env;
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }
  async load(input?: unknown): Promise<void> {
    this.loaded = false;
    this.configs = [];
    this.state = EMPTY();
    if (input === undefined) {
      const content = this.environment.CODEFLOW_NOTIFICATIONS_FILE ? await readFile(this.environment.CODEFLOW_NOTIFICATIONS_FILE, "utf8") : this.environment.CODEFLOW_NOTIFICATIONS_JSON;
      if (content && content.length > 128_000) throw new Error("Notification configuration exceeds 128 KB");
      try { input = content ? JSON.parse(content) : []; } catch { throw new Error("Notification configuration is not valid JSON"); }
    }
    const configs = targetConfigs(input);
    registerPrivateEnvNames(["CODEFLOW_NOTIFICATIONS_FILE", "CODEFLOW_NOTIFICATIONS_JSON", ...configs.flatMap((c) => [c.urlEnv, ...(c.secretEnv ? [c.secretEnv] : [])])]);
    this.configs = configs; this.administratorConfigs = configs;
    const saved = await readFile(this.file, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    let state = EMPTY();
    if (saved !== undefined) {
      if (saved.length > 2 * 1024 * 1024) throw new Error("Notification state exceeds its limit; notifications remain disabled");
      try {
        const parsed = JSON.parse(saved);
        if (parsed.version !== 1 || !parsed.settings || typeof parsed.settings !== "object" || !Array.isArray(parsed.deliveries) || !Array.isArray(parsed.seen)) throw new Error("Invalid state");
        state = { version: 1, settings: Object.create(null), deliveries: [], seen: parsed.seen.filter((key: unknown) => typeof key === "string" && key.length <= 200).slice(-MAX_SEEN) };
        for (const id of Object.keys(parsed.settings)) {
          if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error("Invalid destination ID");
          const value = parsed.settings[id];
          if (value) state.settings[id] = { ...validateNotificationSettings(value), destinationHash: text(value.destinationHash, 64), dropped: Number.isSafeInteger(value.dropped) && value.dropped > 0 ? value.dropped : 0, lastError: text(value.lastError, 300) || undefined };
        }
        for (const value of parsed.deliveries.slice(-MAX_DELIVERIES)) {
          if (!value || !/^notification-[a-f0-9]{24}$/.test(value.id) || typeof value.target !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value.target) || !EVENTS.includes(value.event) || !["pending", "sending", "delivered", "failed", "cancelled"].includes(value.state) || !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt) || !Number.isInteger(value.attempts) || value.attempts < 0 || value.attempts > MAX_ATTEMPTS || !value.payload || value.payload.version !== 1 || value.payload.id !== value.id || value.payload.runId !== value.runId || value.payload.event !== value.event || value.payload.project !== value.project) throw new Error("Invalid delivery");
          const delivery: SavedDelivery = { id: value.id, target: value.target, event: value.event, runId: text(value.runId, 100), teamId: text(value.payload.teamId, 100) || undefined, cycleId: text(value.payload.cycleId, 100) || undefined, project: text(value.project, 100) || undefined, state: value.state,
            attempts: value.attempts, totalAttempts: Number.isSafeInteger(value.totalAttempts) && value.totalAttempts >= value.attempts ? value.totalAttempts : value.attempts, retryCount: Number.isSafeInteger(value.retryCount) && value.retryCount > 0 ? value.retryCount : 0, createdAt: value.createdAt, updatedAt: value.updatedAt, nextAttemptAt: Number.isFinite(value.nextAttemptAt) ? value.nextAttemptAt : undefined,
            httpStatus: Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? value.httpStatus : undefined, reason: text(value.reason, 300) || undefined,
            manual: value.manual === true || undefined, payload: this.payload(value.payload), destinationHash: text(value.destinationHash, 64) };
          if (delivery.state === "sending") { delivery.state = "failed"; delivery.reason = "Delivery outcome is unknown after restart; retry manually if needed"; delivery.nextAttemptAt = undefined; }
          state.deliveries.push(delivery);
        }
      } catch { throw new Error("Notification state is damaged; notifications remain disabled and the file was preserved"); }
    }
    this.configs = configs;
    for (const c of configs) {
      const preference = state.settings[c.id] ?? defaults();
      const destination = this.destination(c);
      if (preference.enabled && (!destination || preference.destinationHash !== destination.hash)) { preference.enabled = false; preference.lastError = "Destination changed or is unavailable; review settings and enable again"; }
      state.settings[c.id] = preference;
    }
    this.state = state;
    this.loaded = true;
  }
  list() {
    return this.redact(this.configs.map((c) => {
      const destination = this.destination(c), setting = this.state.settings[c.id] ?? defaults();
      return { id: c.id, name: c.name, protocol: c.protocol, available: this.loaded, configured: !!destination, host: destination?.url.hostname, administratorManaged: this.administratorConfigs.some(value => value.id === c.id), settings: { enabled: setting.enabled, events: setting.events, projects: setting.projects }, dropped: setting.dropped ?? 0, lastError: setting.lastError };
    }));
  }
  private credential(name: string) { return this.managedEnvironment[name] ?? this.environment[name]; }
  async applyManaged(input: TargetConfig[], credentials: NodeJS.ProcessEnv) {
    const configs = targetConfigs([...this.administratorConfigs, ...input]);
    if (JSON.stringify(configs) === JSON.stringify(this.configs) && JSON.stringify(credentials) === JSON.stringify(this.managedEnvironment)) return;
    const before = this.configs, previousSecrets = this.managedEnvironment;
    try {
      await this.mutate(() => {
        this.configs = configs; this.managedEnvironment = { ...credentials };
        for (const c of configs) {
          const settings = this.state.settings[c.id] ?? defaults(), destination = this.destination(c);
          if (settings.destinationHash !== destination?.hash) { settings.enabled = false; settings.destinationHash = destination?.hash; }
          this.state.settings[c.id] = settings;
        }
        for (const job of this.state.deliveries) if (job.state === "pending" && (!configs.some(c => c.id === job.target) || this.destination(configs.find(c => c.id === job.target)!)?.hash !== job.destinationHash)) {
          job.state = "cancelled"; job.nextAttemptAt = undefined; job.reason = "Destination disconnected or changed"; job.updatedAt = this.now();
        }
      });
    } catch (error) { this.configs = before; this.managedEnvironment = previousSecrets; throw error; }
  }
  deliveries(): NotificationDelivery[] {
    return this.redact([...this.state.deliveries].reverse().map(({ payload: _payload, destinationHash: _hash, ...delivery }) => delivery));
  }
  async update(id: string, value: unknown) {
    const c = this.config(id), settings = validateNotificationSettings(value), destination = this.destination(c);
    if (settings.enabled && !destination) throw new Error("Configure a valid HTTPS destination and credentials before enabling notifications");
    await this.mutate(() => {
      this.state.settings[id] = { ...this.state.settings[id], ...settings, destinationHash: destination?.hash, lastError: undefined };
      for (const job of this.state.deliveries) if (job.target === id && job.state === "pending" && !this.allowed(job, settings)) { job.state = "cancelled"; job.updatedAt = this.now(); job.reason = "Notification settings no longer allow this delivery"; }
    });
    return this.list().find((target) => target.id === id)!;
  }
  async observe(run: RunSummary, extraAttentionKey?: string): Promise<{ queued: number; dropped: number }> {
    if (!this.loaded || this.stopped) return { queued: 0, dropped: 0 };
    const candidates = notificationEvents(run);
    if (extraAttentionKey && !run.archived && !run.projectTeam) candidates.push({ event: "needs-attention", key: `${run.id}:external-attention:${digest(extraAttentionKey.slice(0, 200))}` });
    return this.enqueue(candidates, { runId: run.id, project: run.project, pattern: run.pattern, status: run.status, result: (({ Passed: "verified", Failed: "needs-changes", Blocked: "blocked" } as Record<string, string>)[checksLabel(run)] ?? "unchecked"), title: run.task?.split("\n")[0] ?? "Run update" });
  }
  async observeProjectTeam(team: ProjectTeam) {
    for (const cycle of team.cycles) {
      const opportunities = team.opportunities.filter((o) => o.cycleId === cycle.id || o.id === cycle.opportunityId);
      const actionable = opportunities.some((o) => ["proposed", "ready"].includes(o.status));
      const failed = ["blocked", "failed", "unknown"].includes(cycle.status);
      if (!failed && !(cycle.status === "completed" && actionable)) continue;
      const event: NotificationEvent = failed ? "failure" : "needs-attention";
      await this.enqueue([{ event, key: `${team.id}:${cycle.id}:${cycle.status}` }], { runId: "", teamId: team.id, cycleId: cycle.id, project: team.projectId, pattern: "project-team", status: cycle.status, result: failed ? "blocked" : "ready-for-review", title: `${team.name}: ${cycle.reason ?? cycle.summary ?? "An improvement is ready for review"}` });
    }
  }
  private async enqueue(candidates: { event: NotificationEvent; key: string }[], subject: Omit<NotificationPayload, "version" | "id" | "event">): Promise<{ queued: number; dropped: number }> {
    if (!this.loaded || this.stopped) return { queued: 0, dropped: 0 };
    // Disabled destinations and duplicate snapshots perform no writes and start no requests.
    if (!candidates.length || !this.configs.some((c) => {
      const settings = this.state.settings[c.id] ?? defaults();
      const destination = this.destination(c);
      return destination && settings.destinationHash === destination.hash && settings.enabled && candidates.some((candidate) => this.allowed({ event: candidate.event, project: subject.project }, settings) && !this.state.seen.includes(digest([c.id, candidate.event, candidate.key])));
    })) return { queued: 0, dropped: 0 };
    let queued = 0, dropped = 0;
    await this.mutate(() => {
      for (const c of this.configs) {
        const settings = this.state.settings[c.id] ?? defaults(), destination = this.destination(c);
        if (!destination || !settings.enabled || settings.destinationHash !== destination.hash) continue;
        for (const candidate of candidates) {
          const identity = digest([c.id, candidate.event, candidate.key]);
          if (!this.allowed({ event: candidate.event, project: subject.project }, settings) || this.state.seen.includes(identity)) continue;
          this.state.seen = [...this.state.seen, identity].slice(-MAX_SEEN);
          if (!this.room()) { dropped++; settings.dropped = (settings.dropped ?? 0) + 1; settings.lastError = `Notification queue is full; event for run ${subject.runId} was dropped`; continue; }
          const payload = this.payload({ ...subject, version: 1, id: `notification-${randomBytes(12).toString("hex")}`, event: candidate.event });
          this.state.deliveries.push(this.job(c, destination.hash, payload)); queued++;
        }
      }
    });
    if (queued) void this.drain().catch((error) => logWarn("Notification delivery could not be persisted", { error: (error as Error).message }));
    return { queued, dropped };
  }
  async test(id: string): Promise<NotificationDelivery> {
    const c = this.config(id), destination = this.destination(c);
    if (!destination) throw new Error("Configure a valid HTTPS destination and credentials first");
    let delivery!: SavedDelivery;
    await this.mutate(() => {
      if (!this.room()) throw new Error("Notification queue is full");
      delivery = this.job(c, destination.hash, this.payload({ version: 1, id: `notification-${randomBytes(12).toString("hex")}`, event: "done", runId: "test", pattern: "test", status: "test", result: "test", title: "code-flow notification test", test: true }));
      delivery.manual = true; this.state.deliveries.push(delivery);
    });
    void this.drain().catch((error) => logWarn("Test notification could not be persisted", { error: (error as Error).message }));
    return this.deliveries().find((value) => value.id === delivery.id)!;
  }
  async retry(id: string): Promise<NotificationDelivery> {
    await this.mutate(() => {
      const job = this.state.deliveries.find((value) => value.id === id);
      if (!job || job.state !== "failed") throw new Error("Only a failed notification can be retried");
      const c = this.config(job.target), destination = this.destination(c);
      if (!destination || !job.manual && !this.allowed(job, this.state.settings[c.id] ?? defaults())) throw new Error("Enable this destination and its event/project scope before retrying");
      job.destinationHash = destination.hash; job.attempts = 0; job.retryCount = (job.retryCount ?? 0) + 1; job.state = "pending"; job.nextAttemptAt = this.now(); job.updatedAt = this.now(); job.reason = "Explicit retry requested";
    });
    void this.drain().catch((error) => logWarn("Notification retry could not be persisted", { error: (error as Error).message }));
    return this.deliveries().find((value) => value.id === id)!;
  }
  start(intervalMs = 10_000) {
    if (this.timer || !this.loaded) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.drain().catch((error) => logWarn("Notification retry failed", { error: (error as Error).message })), Math.max(1_000, intervalMs));
    this.timer.unref?.();
  }
  async stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.draining; await this.queue; }
  drain(): Promise<void> { this.draining ??= this.drainAll().finally(() => { this.draining = undefined; }); return this.draining; }
  private async drainAll() {
    if (!this.loaded || this.stopped) return;
    // A pass sends at most 20 requests. Further work waits for the next tick.
    for (let count = 0; count < 20; count++) {
      if (this.stopped) return;
      const candidate = this.state.deliveries.find((value) => value.state === "pending" && (value.nextAttemptAt ?? 0) <= this.now());
      if (!candidate) return;
      // Claim under the same serialized storage mutation as settings changes. A disable queued
      // before this claim must cancel the job rather than letting an old snapshot send it.
      const claimed = await this.mutate(() => {
        const job = this.state.deliveries.find((value) => value.id === candidate.id);
        if (!job || job.state !== "pending" || (job.nextAttemptAt ?? 0) > this.now()) return undefined;
        if (job.attempts >= MAX_ATTEMPTS) { job.state = "failed"; job.reason = "Automatic retry limit reached"; job.updatedAt = this.now(); return undefined; }
        const c = this.configs.find((config) => config.id === job.target), destination = c && this.destination(c);
        if (!c || !destination || destination.hash !== job.destinationHash || !job.manual && !this.allowed(job, this.state.settings[job.target] ?? defaults()) || this.now() - (job.nextAttemptAt ?? job.createdAt) > MAX_PENDING_AGE) {
          job.state = "cancelled"; job.reason = "Destination or scope changed, or this pending delivery expired"; job.updatedAt = this.now(); return undefined;
        }
        job.state = "sending"; job.attempts++; job.totalAttempts = (job.totalAttempts ?? 0) + 1; job.updatedAt = this.now(); job.nextAttemptAt = undefined;
        return { job, c, destination };
      });
      if (!claimed) continue;
      const { job, c, destination } = claimed;
      let status: number | undefined, retryable = true, retryAfter = 30_000, delivered = false;
      try {
        const headers: Record<string, string> = { "content-type": "application/json", "idempotency-key": job.id };
        if (c.secretEnv) headers.authorization = `Bearer ${this.credential(c.secretEnv)}`;
        const message = `code-flow: ${job.event}\n${job.payload.title}\n${job.payload.teamId ? `Team ${job.payload.teamId}` : `Run ${job.runId}`} · ${job.payload.status} · ${job.payload.result}`;
        const slackText = message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
        const body = c.protocol === "slack" ? { text: slackText, blocks: [{ type: "section", text: { type: "plain_text", text: message, emoji: false } }], unfurl_links: false, unfurl_media: false } : job.payload;
        const response = await this.fetcher(destination.url, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(10_000) });
        status = response.status;
        retryable = status === 429 || status >= 500;
        const retry = Number(response.headers.get("retry-after"));
        if (Number.isFinite(retry) && retry > 0) retryAfter = Math.min(300_000, retry * 1_000);
        await response.body?.cancel();
        delivered = response.ok;
      } catch { /* Never retain fetch error text: it can contain a secret destination URL. */ }
      if (delivered) {
        await this.mutate(() => { job.state = "delivered"; job.httpStatus = status; job.reason = undefined; job.updatedAt = this.now(); }); continue;
      }
      await this.mutate(() => {
        job.httpStatus = status; job.updatedAt = this.now();
        job.reason = status ? `Destination returned HTTP ${status}` : "Connection, TLS or timeout failure";
        if (retryable && job.attempts < MAX_ATTEMPTS) { job.state = "pending"; job.nextAttemptAt = this.now() + Math.min(300_000, Math.max(retryAfter, 30_000 * 2 ** (job.attempts - 1))); }
        else job.state = "failed";
      });
    }
  }
  private allowed(job: { event: NotificationEvent; project?: string }, settings: NotificationSettings) { return settings.enabled && settings.events.includes(job.event) && (settings.projects === "all" || settings.projects.includes(job.project ?? "unassigned")); }
  private config(id: string) { const c = this.configs.find((value) => value.id === id); if (!c) throw new Error("Notification destination not found"); return c; }
  private destination(c: TargetConfig): { url: URL; hash: string } | undefined {
    const value = this.credential(c.urlEnv);
    if (!value || value.length > 4_096 || c.secretEnv && !this.credential(c.secretEnv)) return undefined;
    try { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password || url.hash) return undefined; return { url, hash: digest([c.protocol, url.href]) }; } catch { return undefined; }
  }
  private payload(value: NotificationPayload): NotificationPayload { return this.redact({ version: 1, id: text(value.id, 100), event: value.event, runId: text(value.runId, 100), teamId: value.teamId ? text(value.teamId, 100) : undefined, cycleId: value.cycleId ? text(value.cycleId, 100) : undefined, project: value.project ? text(value.project, 100) : undefined, pattern: text(value.pattern, 100), status: text(value.status, 100), result: text(value.result, 100), title: text(this.redact(value.title), 200), ...(value.test ? { test: true } : {}) }); }
  private redact<T>(value: T): T {
    const secrets = this.configs.flatMap((c) => [this.credential(c.urlEnv), c.secretEnv ? this.credential(c.secretEnv) : undefined]).filter((secret): secret is string => !!secret && secret.length >= 8);
    const visit = (item: unknown): unknown => typeof item === "string" ? redactText(item, secrets) : Array.isArray(item) ? item.map(visit) : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry)])) : item;
    return visit(redactExport(value)) as T;
  }
  private job(c: TargetConfig, destinationHash: string, payload: NotificationPayload): SavedDelivery { const at = this.now(); return { id: payload.id, target: c.id, event: payload.event, runId: payload.runId, teamId: payload.teamId, cycleId: payload.cycleId, project: payload.project, state: "pending", attempts: 0, totalAttempts: 0, retryCount: 0, createdAt: at, updatedAt: at, nextAttemptAt: at, destinationHash, payload }; }
  private room(): boolean {
    if (this.state.deliveries.length < MAX_DELIVERIES) return true;
    const index = this.state.deliveries.findIndex((job) => !["pending", "sending"].includes(job.state));
    if (index < 0) return false;
    this.state.deliveries.splice(index, 1); return true;
  }
  private mutate<T>(change: () => T): Promise<T> {
    if (!this.loaded) return Promise.reject(new Error("Notifications are unavailable until their configuration and saved state load successfully"));
    const operation = this.queue.then(async () => {
      const previous = structuredClone(this.state);
      try { const result = change(); await this.save(); return result; }
      catch (error) { this.state = previous; throw error; }
    });
    this.queue = operation.catch(() => undefined); return operation;
  }
  private async save() {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600); try { await handle.writeFile(JSON.stringify(this.state) + "\n"); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, this.file);
      if (process.platform !== "win32") { const directory = await open(dirname(this.file), "r"); try { await directory.sync(); } finally { await directory.close(); } }
    }
    finally { await rm(temporary, { force: true }); }
  }
}
